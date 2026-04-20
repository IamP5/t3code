/**
 * CopilotTextGeneration - Text generation layer using the GitHub Copilot SDK.
 *
 * Each generate* call spawns a throwaway Copilot session (permissions denied
 * by default so the model cannot invoke tools), issues a single
 * `sendAndWait` prompt, and parses the resulting assistant text as JSON
 * matching the prompt's declared output schema.
 *
 * A shared `CopilotClient` is serialized through a Semaphore + idle-close
 * fiber so repeated short-lived git operations don't respawn the CLI for
 * every call.
 *
 * @module CopilotTextGeneration
 */
import { Effect, Exit, Fiber, Layer, Schema, Scope, Semaphore } from "effect";

import {
  type CopilotClient,
  type PermissionHandler,
  type SessionConfig,
} from "@github/copilot-sdk";
import {
  TextGenerationError,
  type CopilotModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import {
  extractJsonObject,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../Utils.ts";
import { createCopilotClient, unwrapCopilotError } from "../../provider/copilotRuntime.ts";

const COPILOT_TEXT_GENERATION_IDLE_TTL = "30 seconds";
const COPILOT_TEXT_GENERATION_REQUEST_TIMEOUT_MS = 180_000;

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

/** Permission handler that refuses every tool request so the model only emits text. */
const denyAllPermissions: PermissionHandler = () => ({
  kind: "denied-by-rules",
  rules: [],
});

interface SharedClientState {
  client: CopilotClient | null;
  binaryPath: string | null;
  serverUrl: string | null;
  activeRequests: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

const makeCopilotTextGeneration = Effect.gen(function* () {
  const serverSettingsService = yield* ServerSettingsService;
  const idleFiberScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const clientMutex = yield* Semaphore.make(1);
  const state: SharedClientState = {
    client: null,
    binaryPath: null,
    serverUrl: null,
    activeRequests: 0,
    idleCloseFiber: null,
  };

  const closeSharedClient = Effect.fn("CopilotTextGeneration.closeSharedClient")(function* () {
    const client = state.client;
    state.client = null;
    state.binaryPath = null;
    state.serverUrl = null;
    if (client !== null) {
      yield* Effect.promise(() => client.stop().then(() => undefined).catch(() => undefined));
    }
  });

  const cancelIdleCloseFiber = Effect.fn("CopilotTextGeneration.cancelIdleCloseFiber")(
    function* () {
      const fiber = state.idleCloseFiber;
      state.idleCloseFiber = null;
      if (fiber !== null) {
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
      }
    },
  );

  const scheduleIdleClose = Effect.fn("CopilotTextGeneration.scheduleIdleClose")(function* (
    client: CopilotClient,
  ) {
    yield* cancelIdleCloseFiber();
    const fiber = yield* Effect.sleep(COPILOT_TEXT_GENERATION_IDLE_TTL).pipe(
      Effect.andThen(
        clientMutex.withPermit(
          Effect.gen(function* () {
            if (state.client !== client || state.activeRequests > 0) {
              return;
            }
            state.idleCloseFiber = null;
            yield* closeSharedClient();
          }),
        ),
      ),
      Effect.forkIn(idleFiberScope),
    );
    state.idleCloseFiber = fiber;
  });

  const acquireSharedClient = (input: {
    readonly binaryPath: string;
    readonly serverUrl: string;
    readonly operation: Operation;
  }) =>
    clientMutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleCloseFiber();

        const existing = state.client;
        const settingsMatch =
          state.binaryPath === input.binaryPath && state.serverUrl === input.serverUrl;

        if (existing !== null && settingsMatch) {
          state.activeRequests += 1;
          return existing;
        }

        if (existing !== null) {
          if (state.activeRequests > 0) {
            state.activeRequests += 1;
            return existing;
          }
          yield* closeSharedClient();
        }

        const client = createCopilotClient({
          binaryPath: input.binaryPath,
          serverUrl: input.serverUrl,
          logLevel: "warning",
        });
        const startExit = yield* Effect.exit(
          Effect.tryPromise({
            try: () => client.start(),
            catch: (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: `Failed to start GitHub Copilot CLI: ${unwrapCopilotError(cause)}`,
                cause,
              }),
          }),
        );
        if (Exit.isFailure(startExit)) {
          yield* Effect.promise(() =>
            client.stop().then(() => undefined).catch(() => undefined),
          );
          return yield* Effect.failCause(startExit.cause);
        }

        state.client = client;
        state.binaryPath = input.binaryPath;
        state.serverUrl = input.serverUrl;
        state.activeRequests = 1;
        return client;
      }),
    );

  const releaseSharedClient = (client: CopilotClient) =>
    clientMutex.withPermit(
      Effect.gen(function* () {
        if (state.client !== client) {
          return;
        }
        state.activeRequests = Math.max(0, state.activeRequests - 1);
        if (state.activeRequests === 0) {
          yield* scheduleIdleClose(client);
        }
      }),
    );

  // Module-level finalizer: ensure we clean up the shared client on layer shutdown.
  yield* Effect.addFinalizer(() =>
    clientMutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleCloseFiber();
        state.activeRequests = 0;
        yield* closeSharedClient();
      }),
    ),
  );

  const runCopilotJson = Effect.fn("runCopilotJson")(function* <S extends Schema.Top>(input: {
    readonly operation: Operation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: CopilotModelSelection;
  }) {
    const copilotSettings = yield* serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.copilot),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `Failed to load Copilot settings: ${String(cause)}`,
            cause,
          }),
      ),
    );

    if (!copilotSettings.enabled) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "GitHub Copilot is disabled in T3 Code settings.",
      });
    }

    const sessionConfig: SessionConfig = {
      workingDirectory: input.cwd,
      clientName: "t3-code",
      onPermissionRequest: denyAllPermissions,
      streaming: false,
      ...(input.modelSelection.model ? { model: input.modelSelection.model } : {}),
    };

    const runAgainstClient = (client: CopilotClient) =>
      Effect.tryPromise({
        try: async () => {
          const session = await client.createSession(sessionConfig);
          try {
            const result = await session.sendAndWait(
              { prompt: input.prompt },
              COPILOT_TEXT_GENERATION_REQUEST_TIMEOUT_MS,
            );
            const content = result?.data?.content;
            if (typeof content !== "string" || content.trim().length === 0) {
              throw new Error("GitHub Copilot returned empty output.");
            }
            return content;
          } finally {
            await session.disconnect().catch(() => undefined);
          }
        },
        catch: (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `GitHub Copilot prompt failed: ${unwrapCopilotError(cause)}`,
            cause,
          }),
      });

    const rawOutput = yield* Effect.acquireUseRelease(
      acquireSharedClient({
        binaryPath: copilotSettings.binaryPath,
        serverUrl: copilotSettings.serverUrl,
        operation: input.operation,
      }),
      runAgainstClient,
      releaseSharedClient,
    );

    return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
      extractJsonObject(rawOutput),
    ).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation: input.operation,
            detail: "GitHub Copilot returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CopilotTextGeneration.generateCommitMessage",
  )(function* (input) {
    if (input.modelSelection.provider !== "copilot") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runCopilotJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "CopilotTextGeneration.generatePrContent",
  )(function* (input) {
    if (input.modelSelection.provider !== "copilot") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    const generated = yield* runCopilotJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CopilotTextGeneration.generateBranchName",
  )(function* (input) {
    if (input.modelSelection.provider !== "copilot") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runCopilotJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CopilotTextGeneration.generateThreadTitle",
  )(function* (input) {
    if (input.modelSelection.provider !== "copilot") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runCopilotJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const CopilotTextGenerationLive = Layer.effect(TextGeneration, makeCopilotTextGeneration);
