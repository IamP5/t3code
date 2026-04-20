/**
 * CopilotAdapterLive - Scoped live implementation for the GitHub Copilot provider adapter.
 *
 * Wraps the `@github/copilot-sdk` client/session behind the generic provider
 * adapter contract and emits canonical runtime events.
 *
 * Focused on happy-path support: startSession, sendTurn, streaming content,
 * permission approvals, user input, and stop. Complex features like full
 * rollback, resume-from-scratch, and history replay are stubbed with
 * minimal implementations suitable for the initial integration.
 *
 * @module CopilotAdapterLive
 */
import * as nodePath from "node:path";

import {
  type CopilotClient,
  type CopilotSession,
  type PermissionHandler,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import { createCopilotClient } from "../copilotRuntime.ts";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Random,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "copilot" as const;
const COPILOT_RESUME_VERSION = 1 as const;

/**
 * Map Copilot's permission kinds onto our canonical request types. Copilot
 * exposes a richer set of permission kinds than our canonical model; fallback
 * to `unknown` when we don't have a direct mapping.
 */
function mapPermissionKindToCanonical(
  kind: PermissionRequest["kind"] | string,
): CanonicalRequestType {
  switch (kind) {
    case "shell":
      return "command_execution_approval";
    case "write":
      return "file_change_approval";
    case "read":
      return "file_read_approval";
    case "mcp":
    case "custom-tool":
      return "dynamic_tool_call";
    default:
      return "unknown";
  }
}

/**
 * Map Copilot's permission kinds onto CanonicalItemType for item.started/completed
 * events emitted around tool use.
 */
function mapPermissionKindToItemType(kind: PermissionRequest["kind"] | string): CanonicalItemType {
  switch (kind) {
    case "shell":
      return "command_execution";
    case "write":
    case "read":
      return "file_change";
    case "mcp":
      return "mcp_tool_call";
    case "custom-tool":
      return "dynamic_tool_call";
    default:
      return "unknown";
  }
}

/**
 * Format a Copilot `PermissionRequest` into a short human-readable detail
 * line used for the runtime `request.opened` event.
 */
function formatPermissionDetail(request: PermissionRequest): string | undefined {
  switch (request.kind) {
    case "shell": {
      const text = (request as { fullCommandText?: unknown }).fullCommandText;
      return typeof text === "string" && text.trim().length > 0 ? text.trim() : undefined;
    }
    case "write":
    case "read": {
      const name = (request as { fileName?: unknown }).fileName;
      const path = (request as { path?: unknown }).path;
      if (typeof name === "string" && name.trim().length > 0) return name.trim();
      if (typeof path === "string" && path.trim().length > 0) return path.trim();
      return undefined;
    }
    case "mcp": {
      const tool = (request as { toolTitle?: unknown }).toolTitle;
      const fallback = (request as { toolName?: unknown }).toolName;
      if (typeof tool === "string" && tool.trim().length > 0) return tool.trim();
      if (typeof fallback === "string" && fallback.trim().length > 0) return fallback.trim();
      return undefined;
    }
    case "custom-tool": {
      const name = (request as { toolName?: unknown }).toolName;
      return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Translate a resolved approval decision from our canonical set into the
 * Copilot SDK's PermissionRequestResult shape.
 */
function toCopilotPermissionResult(decision: ProviderApprovalDecision): PermissionRequestResult {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return { kind: "approved" };
    case "decline":
      return { kind: "denied-interactively-by-user" };
    case "cancel":
      return {
        kind: "denied-interactively-by-user",
        feedback: "User cancelled the request.",
      };
    default:
      return { kind: "denied-interactively-by-user" };
  }
}

/**
 * Deterministic Copilot session id derived from our thread id. Having a
 * stable id keeps resume-session semantics simple: the adapter hands the
 * same id back to `client.resumeSession` without needing a cursor cache.
 */
function copilotSessionIdForThread(threadId: ThreadId): string {
  return `copilot-${threadId}`;
}

/**
 * Parse a stored resume cursor (from a prior session) into the Copilot
 * session id string. Returns undefined when the cursor is missing/invalid.
 */
function parseCopilotResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== COPILOT_RESUME_VERSION) return undefined;
  const sessionId = record.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return undefined;
  return { sessionId: sessionId.trim() };
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly requestType: CanonicalRequestType;
  readonly itemType: CanonicalItemType;
  readonly itemId: string;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  readonly questionId: string;
}

interface CopilotSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly client: CopilotClient;
  sdkSession: CopilotSession;
  readonly copilotSessionId: string;
  unsubscribeEvents: (() => void) | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  /** Tracks emitted text per Copilot messageId so we can synthesize deltas if needed. */
  readonly emittedAssistantText: Map<string, string>;
  /** Tracks emitted `item.started` markers for assistant messages (keyed by messageId). */
  readonly startedAssistantMessages: Set<string>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}

export interface CopilotAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const entries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    entries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsEmpty(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const entries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    entries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

function toErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (typeof cause === "string" && cause.length > 0) return cause;
  return fallback;
}

function makeCopilotAdapter(options?: CopilotAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const serverSettingsService = yield* ServerSettingsService;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, CopilotSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CopilotSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: CopilotSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmpty(ctx.pendingUserInputs);
        if (ctx.unsubscribeEvents) {
          const unsub = ctx.unsubscribeEvents;
          ctx.unsubscribeEvents = undefined;
          yield* Effect.sync(() => {
            try {
              unsub();
            } catch {
              // best-effort
            }
          });
        }
        yield* Effect.tryPromise(() => ctx.sdkSession.disconnect()).pipe(Effect.ignore);
        yield* Effect.tryPromise(() => ctx.client.stop().then(() => undefined)).pipe(Effect.ignore);
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    /**
     * Handle raw Copilot session events and translate them into our canonical
     * runtime events. Only a focused subset is bridged — assistant text,
     * turn boundaries, idle/error signals, and user_input requests.
     */
    const handleSessionEvent = (ctx: CopilotSessionContext, event: SessionEvent) =>
      Effect.gen(function* () {
        yield* logNative(ctx.threadId, `session.event.${event.type}`, event);
        switch (event.type) {
          case "assistant.turn_start": {
            // We maintain our own t3 turnId separately; no bridge needed.
            return;
          }
          case "assistant.message_delta": {
            const delta = event.data.deltaContent;
            if (!delta || delta.length === 0) return;
            const messageId = event.data.messageId;
            if (!ctx.startedAssistantMessages.has(messageId)) {
              ctx.startedAssistantMessages.add(messageId);
              yield* offerRuntimeEvent({
                type: "item.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                itemId: RuntimeItemId.make(messageId),
                payload: {
                  itemType: "assistant_message",
                  status: "inProgress",
                  title: "Assistant message",
                },
              });
            }
            const previous = ctx.emittedAssistantText.get(messageId) ?? "";
            ctx.emittedAssistantText.set(messageId, previous + delta);
            yield* offerRuntimeEvent({
              type: "content.delta",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              itemId: RuntimeItemId.make(messageId),
              payload: {
                streamKind: "assistant_text",
                delta,
              },
            });
            return;
          }
          case "assistant.message": {
            const messageId = event.data.messageId;
            const finalText = event.data.content ?? "";
            const already = ctx.emittedAssistantText.get(messageId);
            if (!ctx.startedAssistantMessages.has(messageId)) {
              ctx.startedAssistantMessages.add(messageId);
              yield* offerRuntimeEvent({
                type: "item.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                itemId: RuntimeItemId.make(messageId),
                payload: {
                  itemType: "assistant_message",
                  status: "inProgress",
                  title: "Assistant message",
                },
              });
            }
            if ((already === undefined || already.length === 0) && finalText.length > 0) {
              yield* offerRuntimeEvent({
                type: "content.delta",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                itemId: RuntimeItemId.make(messageId),
                payload: {
                  streamKind: "assistant_text",
                  delta: finalText,
                },
              });
              ctx.emittedAssistantText.set(messageId, finalText);
            }
            const completedPayload: {
              readonly itemType: "assistant_message";
              readonly status: "completed";
              readonly title: string;
              readonly detail?: string;
            } =
              finalText.length > 0
                ? {
                    itemType: "assistant_message",
                    status: "completed",
                    title: "Assistant message",
                    detail: finalText,
                  }
                : {
                    itemType: "assistant_message",
                    status: "completed",
                    title: "Assistant message",
                  };
            yield* offerRuntimeEvent({
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              itemId: RuntimeItemId.make(messageId),
              payload: completedPayload,
            });
            return;
          }
          case "assistant.reasoning": {
            const reasoningData = event.data as { content?: unknown };
            const content = reasoningData.content;
            if (typeof content !== "string" || content.length === 0) return;
            const reasoningItemId = RuntimeItemId.make(event.id);
            yield* offerRuntimeEvent({
              type: "content.delta",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              itemId: reasoningItemId,
              payload: {
                streamKind: "reasoning_text",
                delta: content,
              },
            });
            return;
          }
          case "user_input.requested": {
            const requestId = event.data.requestId;
            const question = event.data.question;
            const choices = Array.isArray(event.data.choices) ? event.data.choices : [];
            const runtimeApprovalId = ApprovalRequestId.make(crypto.randomUUID());
            const runtimeRequestId = RuntimeRequestId.make(runtimeApprovalId);
            const questionId = typeof requestId === "string" ? requestId : crypto.randomUUID();
            const answers = yield* Deferred.make<ProviderUserInputAnswers>();
            ctx.pendingUserInputs.set(runtimeApprovalId, { answers, questionId });

            const options = choices
              .filter((choice): choice is string => typeof choice === "string" && choice.length > 0)
              .map((choice) => ({
                label: choice,
                description: choice,
              }));
            const questions: ReadonlyArray<UserInputQuestion> = [
              {
                id: questionId,
                header: "Copilot",
                question:
                  typeof question === "string" && question.length > 0
                    ? question
                    : "Copilot needs input",
                options,
                multiSelect: false,
              },
            ];

            yield* offerRuntimeEvent({
              type: "user-input.requested",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              requestId: runtimeRequestId,
              payload: { questions },
            });
            return;
          }
          case "session.idle": {
            // Session idle signals end of an agentic loop between turns; our own
            // sendTurn flow already emits turn.completed, so no-op here.
            return;
          }
          case "session.error": {
            const errorData = event.data as { message?: unknown };
            const message =
              typeof errorData.message === "string" && errorData.message.length > 0
                ? errorData.message
                : "Copilot session error";
            yield* offerRuntimeEvent({
              type: "runtime.error",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              payload: {
                message,
                class: "provider_error",
              },
            });
            return;
          }
          case "session.shutdown": {
            yield* offerRuntimeEvent({
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              payload: {
                state: "stopped",
                reason: "Copilot session shutdown",
              },
            });
            return;
          }
          default:
            return;
        }
      });

    /**
     * Build the `PermissionHandler` wired into `SessionConfig`. The returned
     * callback is invoked synchronously from the SDK and must return a promise
     * that resolves with the approval result.
     *
     * Under the hood we allocate a native JS resolver that we surface into the
     * adapter's pending-approvals map via a `Deferred` proxy. That way external
     * callers of `respondToRequest` can succeed the Deferred and unblock the
     * SDK callback.
     */
    const buildPermissionHandler =
      (ctxRef: { ref: CopilotSessionContext | undefined }): PermissionHandler =>
      async (request) => {
        const ctx = ctxRef.ref;
        if (!ctx || ctx.stopped) {
          return { kind: "denied-interactively-by-user", feedback: "Session is not active." };
        }

        const requestType = mapPermissionKindToCanonical(request.kind);
        const itemType = mapPermissionKindToItemType(request.kind);
        const toolCallIdRaw = (request as { toolCallId?: unknown }).toolCallId;
        const toolCallId = typeof toolCallIdRaw === "string" ? toolCallIdRaw : undefined;
        const itemId = toolCallId ?? crypto.randomUUID();
        const runtimeApprovalId = ApprovalRequestId.make(crypto.randomUUID());
        const runtimeRequestId = RuntimeRequestId.make(runtimeApprovalId);
        const detail = formatPermissionDetail(request);

        const decisionDeferred = await Effect.runPromise(Deferred.make<ProviderApprovalDecision>());

        ctx.pendingApprovals.set(runtimeApprovalId, {
          decision: decisionDeferred,
          requestType,
          itemType,
          itemId,
        });

        const openEvent: Effect.Effect<void> = Effect.gen(function* () {
          yield* offerRuntimeEvent({
            type: "request.opened",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            requestId: runtimeRequestId,
            payload: {
              requestType,
              ...(detail ? { detail } : {}),
              args: request,
            },
          });
        });

        await Effect.runPromise(openEvent).catch(() => undefined);

        const decision = await Effect.runPromise(Deferred.await(decisionDeferred));
        ctx.pendingApprovals.delete(runtimeApprovalId);

        const resolveEvent: Effect.Effect<void> = Effect.gen(function* () {
          yield* offerRuntimeEvent({
            type: "request.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            requestId: runtimeRequestId,
            payload: {
              requestType,
              decision,
            },
          });
        });
        await Effect.runPromise(resolveEvent).catch(() => undefined);

        return toCopilotPermissionResult(decision);
      };

    const startSession: CopilotAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = nodePath.resolve(input.cwd.trim());
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const copilotSettings = yield* serverSettingsService.getSettings.pipe(
            Effect.map((settings) => settings.providers.copilot),
            Effect.mapError(
              (error) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: error.message,
                  cause: error,
                }),
            ),
          );

          const copilotModelSelection =
            input.modelSelection?.provider === "copilot" ? input.modelSelection : undefined;

          const resumeInfo = parseCopilotResume(input.resumeCursor);
          const sessionId = resumeInfo?.sessionId ?? copilotSessionIdForThread(input.threadId);

          const ctxRef: { ref: CopilotSessionContext | undefined } = { ref: undefined };

          const client = createCopilotClient({
            binaryPath: copilotSettings.binaryPath,
            serverUrl: copilotSettings.serverUrl,
            cwd,
            logLevel: "warning",
          });

          const sessionConfigBase: SessionConfig = copilotModelSelection?.model
            ? {
                sessionId,
                workingDirectory: cwd,
                clientName: "t3-code",
                onPermissionRequest: buildPermissionHandler(ctxRef),
                streaming: true,
                model: copilotModelSelection.model,
              }
            : {
                sessionId,
                workingDirectory: cwd,
                clientName: "t3-code",
                onPermissionRequest: buildPermissionHandler(ctxRef),
                streaming: true,
              };

          const startResult = yield* Effect.tryPromise({
            try: async () => {
              await client.start();
              try {
                return await client.resumeSession(sessionId, sessionConfigBase);
              } catch {
                return await client.createSession(sessionConfigBase);
              }
            },
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: toErrorMessage(cause, "Failed to start Copilot session."),
                cause,
              }),
          });

          const now = yield* nowIso;
          const session: ProviderSession = copilotModelSelection?.model
            ? {
                provider: PROVIDER,
                status: "ready",
                runtimeMode: input.runtimeMode,
                cwd,
                model: copilotModelSelection.model,
                threadId: input.threadId,
                resumeCursor: {
                  schemaVersion: COPILOT_RESUME_VERSION,
                  sessionId: startResult.sessionId,
                },
                createdAt: now,
                updatedAt: now,
              }
            : {
                provider: PROVIDER,
                status: "ready",
                runtimeMode: input.runtimeMode,
                cwd,
                threadId: input.threadId,
                resumeCursor: {
                  schemaVersion: COPILOT_RESUME_VERSION,
                  sessionId: startResult.sessionId,
                },
                createdAt: now,
                updatedAt: now,
              };

          const ctx: CopilotSessionContext = {
            threadId: input.threadId,
            session,
            client,
            sdkSession: startResult,
            copilotSessionId: startResult.sessionId,
            unsubscribeEvents: undefined,
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            emittedAssistantText: new Map(),
            startedAssistantMessages: new Set(),
            turns: [],
            activeTurnId: undefined,
            stopped: false,
          };
          ctxRef.ref = ctx;
          sessions.set(input.threadId, ctx);

          // Subscribe to SDK session events. The SDK dispatcher is synchronous
          // — we run the Effect bridging work via runFork so as not to block
          // event delivery.
          ctx.unsubscribeEvents = startResult.on((event) => {
            Effect.runFork(handleSessionEvent(ctx, event).pipe(Effect.ignore));
          });

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: { sessionId: startResult.sessionId } },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Copilot session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: startResult.sessionId },
          });

          return session;
        }),
      );

    const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.provider === "copilot" ? input.modelSelection : undefined;

        if (turnModelSelection?.model && turnModelSelection.model !== ctx.session.model) {
          const targetModel = turnModelSelection.model;
          yield* Effect.tryPromise({
            try: () => ctx.sdkSession.setModel(targetModel),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.setModel",
                detail: toErrorMessage(cause, "Failed to switch Copilot model."),
                cause,
              }),
          });
        }

        ctx.activeTurnId = turnId;
        ctx.session = turnModelSelection?.model
          ? {
              ...ctx.session,
              activeTurnId: turnId,
              model: turnModelSelection.model,
              updatedAt: yield* nowIso,
            }
          : {
              ...ctx.session,
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

        const promptSegments: string[] = [];
        if (input.input?.trim()) {
          promptSegments.push(input.input.trim());
        }

        const blobAttachments: Array<{
          readonly type: "blob";
          readonly data: string;
          readonly mimeType: string;
          readonly displayName?: string;
        }> = [];
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of input.attachments) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.send",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.send",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            blobAttachments.push({
              type: "blob",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
              displayName: attachment.name,
            });
          }
        }

        if (promptSegments.length === 0 && blobAttachments.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const prompt = promptSegments.join("\n\n");

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: ctx.session.model ? { model: ctx.session.model } : {},
        });

        const sendOptions =
          blobAttachments.length > 0
            ? { prompt: prompt.length > 0 ? prompt : " ", attachments: blobAttachments }
            : { prompt };

        const sendResult = yield* Effect.tryPromise({
          try: () => ctx.sdkSession.sendAndWait(sendOptions),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.send",
              detail: toErrorMessage(cause, "Copilot turn failed."),
              cause,
            }),
        });

        ctx.turns.push({ id: turnId, items: [{ prompt, result: sendResult }] });
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { state: "completed" },
        });

        return {
          threadId: input.threadId,
          turnId,
          ...(ctx.session.resumeCursor !== undefined
            ? { resumeCursor: ctx.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmpty(ctx.pendingUserInputs);
        yield* Effect.tryPromise(() => ctx.sdkSession.abort()).pipe(Effect.ignore);
      });

    const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "permission.respond",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user_input.respond",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
        ctx.pendingUserInputs.delete(requestId);
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          turnId: ctx.activeTurnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers },
        });
      });

    const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: CopilotAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        // Best-effort in-memory truncation — the Copilot CLI holds the real
        // conversation history and does not expose a rollback API.
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: CopilotAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: CopilotAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies CopilotAdapterShape;
  });
}

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());

export function makeCopilotAdapterLive(opts?: CopilotAdapterLiveOptions) {
  return Layer.effect(CopilotAdapter, makeCopilotAdapter(opts));
}
