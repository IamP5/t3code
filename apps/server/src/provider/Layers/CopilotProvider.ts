import type {
  CopilotSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { ServerSettingsError } from "@t3tools/contracts";
import { Cache, Duration, Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { type GetAuthStatusResponse, type ModelInfo } from "@github/copilot-sdk";

import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { CopilotProvider } from "../Services/CopilotProvider.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  createCopilotClient,
  isCopilotMissingBinaryError,
  unwrapCopilotError,
} from "../copilotRuntime.ts";

const PROVIDER = "copilot" as const;

const DEFAULT_COPILOT_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "gpt-4.1",
    name: "GPT-4.1",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
];

export function getCopilotModelCapabilities(_model: string | null | undefined): ModelCapabilities {
  return DEFAULT_COPILOT_MODEL_CAPABILITIES;
}

const SDK_PROBE_TIMEOUT_MS = 10_000;

interface CopilotProbe {
  readonly version: string | null;
  readonly auth: GetAuthStatusResponse | null;
  readonly models: ReadonlyArray<ModelInfo>;
  readonly missingBinary: boolean;
  readonly errorMessage?: string;
}

interface CopilotProbeInput {
  readonly binaryPath: string;
  readonly serverUrl: string;
}

/**
 * Probe the Copilot CLI by spawning it via the SDK. Reads version, auth
 * status, and available models in one pass. Cached for 5 minutes to avoid
 * repeatedly spawning the CLI for refresh cycles.
 */
const probeCopilot = (input: CopilotProbeInput): Effect.Effect<CopilotProbe> =>
  Effect.tryPromise(async (): Promise<CopilotProbe> => {
    const client = createCopilotClient({
      binaryPath: input.binaryPath,
      serverUrl: input.serverUrl,
    });
    try {
      await client.start();
      const status = await client.getStatus().catch(() => null);
      const auth = await client.getAuthStatus().catch(() => null);
      const models = await client.listModels().catch(() => [] as ModelInfo[]);
      return {
        version: status?.version ?? null,
        auth,
        models,
        missingBinary: false,
      };
    } finally {
      await client.stop().catch(() => undefined);
    }
  }).pipe(
    Effect.timeoutOption(SDK_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result): CopilotProbe => {
      if (Result.isFailure(result)) {
        const message = unwrapCopilotError(result.failure);
        return {
          version: null,
          auth: null,
          models: [],
          missingBinary: isCopilotMissingBinaryError(message),
          errorMessage: message,
        };
      }
      if (Option.isNone(result.success)) {
        return {
          version: null,
          auth: null,
          models: [],
          missingBinary: false,
          errorMessage: "GitHub Copilot CLI probe timed out.",
        };
      }
      return result.success.value;
    }),
  );

function mapProbeToStatus(probe: CopilotProbe): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: Pick<ServerProviderAuth, "status" | "type" | "label">;
  readonly message?: string;
  readonly installed: boolean;
} {
  if (probe.missingBinary) {
    return {
      installed: false,
      status: "error",
      auth: { status: "unknown" },
      message: "GitHub Copilot CLI (`copilot`) is not installed or not on PATH.",
    };
  }

  if (probe.errorMessage && probe.auth === null) {
    return {
      installed: true,
      status: "error",
      auth: { status: "unknown" },
      message: `Could not connect to GitHub Copilot CLI. ${probe.errorMessage}`,
    };
  }

  if (!probe.auth) {
    return {
      installed: true,
      status: "warning",
      auth: { status: "unknown" },
      message: "Could not verify GitHub Copilot authentication status.",
    };
  }

  if (!probe.auth.isAuthenticated) {
    return {
      installed: true,
      status: "error",
      auth: { status: "unauthenticated" },
      message:
        probe.auth.statusMessage ??
        "GitHub Copilot is not authenticated. Run `copilot auth login` and try again.",
    };
  }

  const authDetail: Pick<ServerProviderAuth, "status" | "type" | "label"> = {
    status: "authenticated",
    ...(probe.auth.authType ? { type: probe.auth.authType } : {}),
    ...(probe.auth.login
      ? { label: `GitHub Copilot (${probe.auth.login})` }
      : probe.auth.authType
        ? { label: `GitHub Copilot ${probe.auth.authType}` }
        : {}),
  };

  return {
    installed: true,
    status: "ready",
    auth: authDetail,
  };
}

function modelsFromProbe(models: ReadonlyArray<ModelInfo>): ReadonlyArray<ServerProviderModel> {
  if (models.length === 0) return BUILT_IN_MODELS;
  return models.map<ServerProviderModel>((model) => ({
    slug: model.id,
    name: model.name ?? model.id,
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  }));
}

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  resolveProbe?: (input: CopilotProbeInput) => Effect.Effect<CopilotProbe>,
): Effect.fn.Return<
  ServerProvider,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
> {
  const copilotSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.copilot),
  );
  const checkedAt = new Date().toISOString();
  const seedModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    copilotSettings.customModels,
    DEFAULT_COPILOT_MODEL_CAPABILITIES,
  );

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: seedModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const probeInput: CopilotProbeInput = {
    binaryPath: copilotSettings.binaryPath,
    serverUrl: copilotSettings.serverUrl,
  };
  const probe = yield* resolveProbe ? resolveProbe(probeInput) : probeCopilot(probeInput);
  const outcome = mapProbeToStatus(probe);
  const models = providerModelsFromSettings(
    outcome.status === "ready" ? modelsFromProbe(probe.models) : BUILT_IN_MODELS,
    PROVIDER,
    copilotSettings.customModels,
    DEFAULT_COPILOT_MODEL_CAPABILITIES,
  );

  return buildServerProvider({
    provider: PROVIDER,
    enabled: copilotSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: outcome.installed,
      version: probe.version,
      status: outcome.status,
      auth: outcome.auth,
      ...(outcome.message ? { message: outcome.message } : {}),
    },
  });
});

const makePendingCopilotProvider = (copilotSettings: CopilotSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    copilotSettings.customModels,
    DEFAULT_COPILOT_MODEL_CAPABILITIES,
  );

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "GitHub Copilot provider status has not been checked in this session yet.",
    },
  });
};

export const CopilotProviderLive = Layer.effect(
  CopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const probeCache = yield* Cache.make({
      capacity: 4,
      timeToLive: Duration.minutes(5),
      lookup: (key: string) => {
        const [binaryPath, serverUrl] = key.split("\u0001");
        return probeCopilot({ binaryPath: binaryPath ?? "", serverUrl: serverUrl ?? "" });
      },
    });

    const checkProvider = checkCopilotProviderStatus((probeInput) =>
      Cache.get(probeCache, `${probeInput.binaryPath}\u0001${probeInput.serverUrl}`),
    ).pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.copilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makePendingCopilotProvider,
      checkProvider,
    });
  }),
);
