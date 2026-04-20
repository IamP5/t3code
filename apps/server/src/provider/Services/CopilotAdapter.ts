/**
 * CopilotAdapter - GitHub Copilot CLI implementation of the generic provider adapter contract.
 *
 * This service owns Copilot session semantics and emits canonical provider
 * runtime events. It does not perform cross-provider routing, shared event
 * fan-out, or checkpoint orchestration.
 *
 * Uses Effect `Context.Service` for dependency injection and returns the
 * shared provider-adapter error channel with `provider: "copilot"` context.
 *
 * @module CopilotAdapter
 */
import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * CopilotAdapterShape - Service API for the GitHub Copilot provider adapter.
 */
export interface CopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "copilot";
}

/**
 * CopilotAdapter - Service tag for GitHub Copilot provider adapter operations.
 */
export class CopilotAdapter extends Context.Service<CopilotAdapter, CopilotAdapterShape>()(
  "t3/provider/Services/CopilotAdapter",
) {}
