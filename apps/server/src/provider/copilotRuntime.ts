/**
 * Shared GitHub Copilot SDK client helpers.
 *
 * Centralizes client construction so the status probe, session adapter, and
 * git text-generation layer all agree on how to resolve `cliPath` / `cliUrl`
 * and how to unwrap SDK error causes.
 */
import { CopilotClient, type CopilotClientOptions } from "@github/copilot-sdk";

export interface BuildCopilotClientOptionsInput {
  readonly binaryPath: string;
  readonly serverUrl?: string | null | undefined;
  readonly cwd?: string | undefined;
  readonly logLevel?: CopilotClientOptions["logLevel"];
}

/** Trim a string; return `undefined` for empty / missing values. */
export function trimOrUndefined(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build a `CopilotClientOptions` object honoring the user's settings.
 *
 * `cliPath` is only forwarded when the user customized it away from the
 * default literal `"copilot"` — otherwise the SDK falls back to its bundled
 * `@github/copilot` binary (which is resolvable even when the CLI is not on
 * the server process's PATH).
 *
 * `cliUrl` takes precedence over `cliPath` when provided (Copilot Enterprise
 * / self-hosted servers).
 */
export function buildCopilotClientOptions(
  input: BuildCopilotClientOptionsInput,
): CopilotClientOptions {
  const serverUrl = trimOrUndefined(input.serverUrl);
  const binaryPath = trimOrUndefined(input.binaryPath);
  const useCustomCliPath = binaryPath !== undefined && binaryPath !== "copilot";

  const options: CopilotClientOptions = {};
  if (serverUrl !== undefined) {
    options.cliUrl = serverUrl;
  } else if (useCustomCliPath) {
    options.cliPath = binaryPath;
  }
  if (input.cwd !== undefined) {
    options.cwd = input.cwd;
  }
  if (input.logLevel !== undefined) {
    options.logLevel = input.logLevel;
  }
  return options;
}

/** Create a `CopilotClient` using resolved options. */
export function createCopilotClient(input: BuildCopilotClientOptionsInput): CopilotClient {
  return new CopilotClient(buildCopilotClientOptions(input));
}

/**
 * Walk a nested error chain (SDK wraps errors with `.cause` / `.error`) and
 * collect a human-readable message. Returns `"Unknown error"` as a fallback.
 */
export function unwrapCopilotError(cause: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = cause;
  let message = "";
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.message && !message.includes(current.message)) {
        message = message ? `${message} | ${current.message}` : current.message;
      }
      const next =
        (current as Error & { cause?: unknown; error?: unknown }).cause ??
        (current as Error & { cause?: unknown; error?: unknown }).error;
      if (next && next !== current) {
        current = next;
        continue;
      }
      break;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (typeof record.message === "string") {
        message = message ? `${message} | ${record.message}` : record.message;
      }
      const next = record.cause ?? record.error;
      if (next && next !== current) {
        current = next;
        continue;
      }
      break;
    }
    message = message ? `${message} | ${String(current)}` : String(current);
    break;
  }
  return message || "Unknown error";
}

/**
 * Classify a copilot error message to decide whether the CLI is missing /
 * not installed vs. a different runtime failure.
 */
export function isCopilotMissingBinaryError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("enoent") ||
    lower.includes("command not found") ||
    lower.includes("is not installed") ||
    lower.includes("cannot find")
  );
}
