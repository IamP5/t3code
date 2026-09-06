# Feature Mode — t3code sidebar view toggle + multi-repo feature workflows

## Context

Today t3code models one **project = one repo**; every `OrchestrationThread` has a required `projectId` pointing to an `OrchestrationProject` with a `workspaceRoot` and optional `repositoryIdentity` (`packages/contracts/src/orchestration.ts:184-340`). The sidebar groups threads by project using `deriveLogicalProjectKey` (`apps/web/src/logicalProject.ts:108-124`) with three pre-existing grouping modes (`packages/contracts/src/settings.ts:28-34`).

This works for a single-repo developer, but not for enterprise users doing technical refinement on a feature that spans many micro-services / micro-frontends. They need to: (a) define a **Feature** by a JIRA key, (b) link multiple existing repos to it, (c) run a refinement workflow that inspects all linked repos and produces a plan doc, and (d) fan out execution sessions — one per repo — that each run Copilot in the right cwd so they pick up repo-local `AGENTS.md` / skills.

**Outcome:** a client-side **sidebar view toggle** (Repos ⇄ Features) that overlays the existing repo model with a thin `Feature` layer plus two new `FeatureTask` workflows (refinement, execution) built on existing thread/provider machinery, and a pluggable JIRA connector stub.

### Design decisions (confirmed)
- **JIRA integration:** free-form string key now; `JiraConnector` interface shipped so a cloud connector can drop in later.
- **Tech refinement runtime:** one coordinator session (in a dedicated feature workspace cwd) + per-repo **read-only** child sessions. Fits the one-cwd-per-session constraint the Copilot adapter already enforces (`apps/server/src/provider/Layers/CopilotAdapter.ts`).
- **Toggle UX:** global segmented control in `SidebarChromeHeader` (`apps/web/src/components/Sidebar.tsx:2341-2381`), persisted in `ClientSettings`.

### Reuse over parallel code
- Extend `ClientSettingsSchema` (don't fork settings).
- Reuse `OrchestrationProject` / `OrchestrationThread` verbatim; add optional `featureId` / `parentThreadId` / `threadRole` / `threadAccessMode` columns with decoding defaults so existing data decodes unchanged.
- Mirror `deriveLogicalProjectKey` with a new `deriveLogicalFeatureKey`; reuse `sortProjectsForSidebar` for manual/updated_at sort of features.
- Refinement plugin pattern mirrors `CodexDeveloperInstructions.ts` (hardcoded strings) — the closest existing convention; no general plugin framework.

---

## 1. New domain entities

Edits to `packages/contracts/src/orchestration.ts` (add alongside existing ids near the top, structs after `OrchestrationProject` at L195, commands after L499, events after L972):

```ts
export const FeatureId = TrimmedNonEmptyString.pipe(Schema.brand("FeatureId"));
export const FeatureTaskId = TrimmedNonEmptyString.pipe(Schema.brand("FeatureTaskId"));
export const JiraIssueKey = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Z][A-Z0-9]+-\d+$/));

export const FeatureStatus = Schema.Literals([
  "draft", "refining", "refined", "executing", "completed", "archived",
]);

export const FeatureRepoLink = Schema.Struct({
  featureId: FeatureId,
  projectId: ProjectId,                     // reuse existing project rows
  role: Schema.Literals(["primary", "secondary"]),
  addedAt: IsoDateTime,
});

export const Feature = Schema.Struct({
  id: FeatureId,
  jiraKey: Schema.NullOr(JiraIssueKey),
  jiraConnectorId: Schema.NullOr(TrimmedNonEmptyString),  // e.g. "manual" | "jira-cloud"
  title: TrimmedNonEmptyString,
  summary: Schema.NullOr(TrimmedString),
  status: FeatureStatus,
  workspaceDir: TrimmedNonEmptyString,      // absolute cwd for coordinator
  defaultModelSelection: Schema.NullOr(ModelSelection),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
  repoLinks: Schema.Array(FeatureRepoLink), // denormalized for read model
});

export const FeatureTask = Schema.Struct({
  id: FeatureTaskId,
  featureId: FeatureId,
  kind: Schema.Literals(["refinement", "execution"]),
  coordinatorThreadId: Schema.NullOr(ThreadId), // null for execution kind
  childThreadIds: Schema.Array(ThreadId),
  status: Schema.Literals(["pending", "running", "completed", "failed", "cancelled"]),
  pluginId: Schema.NullOr(TrimmedNonEmptyString),
  pluginConfigJson: Schema.NullOr(Schema.String),
  outputDocPath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
```

**Extend `OrchestrationThread` (L316-340) and `OrchestrationThreadShell` (L362-383)** — add four optional fields with decoding defaults so all existing projections decode unchanged:

```ts
parentThreadId: Schema.NullOr(ThreadId)
  .pipe(Schema.withDecodingDefault(Effect.succeed(null))),
featureId: Schema.NullOr(FeatureId)
  .pipe(Schema.withDecodingDefault(Effect.succeed(null))),
threadRole: Schema.Literals(["standalone", "coordinator", "child"])
  .pipe(Schema.withDecodingDefault(Effect.succeed("standalone" as const))),
threadAccessMode: Schema.Literals(["read-write", "read-only"])
  .pipe(Schema.withDecodingDefault(Effect.succeed("read-write" as const))),
```

**New commands** (append to the command union near L465-499):
`feature.create`, `feature.meta-update`, `feature.archive`, `feature.delete`, `feature.repo-link.add`, `feature.repo-link.remove`, `feature-task.start.refinement`, `feature-task.start.execution`, `feature-task.cancel`, `feature-task.child-thread-attached`.

**New events:** matching `*.created`, `*.updated`, `*.archived`, `*.deleted`, `*.status-changed`, etc. Extend `OrchestrationAggregateKind` with `"feature"` and `"feature-task"`, and widen `EventBaseFields.aggregateId` to `Schema.Union([ProjectId, ThreadId, FeatureId, FeatureTaskId])`.

Extend `OrchestrationReadModel` / `OrchestrationShellSnapshot` (L342-391) with `features: Schema.Array(Feature)` and `featureTasks: Schema.Array(FeatureTask)`, plus `feature-upserted`, `feature-removed`, `feature-task-upserted`, `feature-task-removed` shell stream events.

---

## 2. Database migrations

Latest existing migration is `025_CleanupInvalidProjectionPendingApprovals.ts` — new migrations are **026** and **027**.

### `apps/server/src/persistence/Migrations/026_FeatureMode.ts`
```sql
CREATE TABLE IF NOT EXISTS projection_features (
  feature_id TEXT PRIMARY KEY,
  jira_key TEXT,
  jira_connector_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  default_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT
);
CREATE INDEX idx_projection_features_updated_at ON projection_features(updated_at);
CREATE INDEX idx_projection_features_jira_key ON projection_features(jira_key)
  WHERE jira_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS projection_feature_repo_links (
  feature_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (feature_id, project_id)
);
CREATE INDEX idx_projection_feature_repo_links_project
  ON projection_feature_repo_links(project_id);

CREATE TABLE IF NOT EXISTS projection_feature_tasks (
  feature_task_id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  coordinator_thread_id TEXT,
  status TEXT NOT NULL,
  plugin_id TEXT,
  plugin_config_json TEXT,
  output_doc_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_projection_feature_tasks_feature
  ON projection_feature_tasks(feature_id);
CREATE INDEX idx_projection_feature_tasks_status
  ON projection_feature_tasks(status);
```

### `apps/server/src/persistence/Migrations/027_ProjectionThreadsFeatureColumns.ts`
```sql
ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT;
ALTER TABLE projection_threads ADD COLUMN feature_id TEXT;
ALTER TABLE projection_threads ADD COLUMN thread_role TEXT NOT NULL DEFAULT 'standalone';
ALTER TABLE projection_threads ADD COLUMN thread_access_mode TEXT NOT NULL DEFAULT 'read-write';
CREATE INDEX idx_projection_threads_feature_id ON projection_threads(feature_id)
  WHERE feature_id IS NOT NULL;
CREATE INDEX idx_projection_threads_parent_thread ON projection_threads(parent_thread_id)
  WHERE parent_thread_id IS NOT NULL;

ALTER TABLE projection_projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'repo';
-- 'repo' (default) or 'feature-workspace' (hidden from repo sidebar)
```

No data backfill needed — the view toggle defaults to `repo`, so existing users see unchanged behavior.

---

## 3. Settings additions

Edits to `packages/contracts/src/settings.ts` (after L34, inside `ClientSettingsSchema` at L36-62, and mirror in `ClientSettingsPatch` at L296-316):

```ts
export const SidebarViewMode = Schema.Literals(["repo", "feature"]);
export const DEFAULT_SIDEBAR_VIEW_MODE: SidebarViewMode = "repo";

export const SidebarFeatureSortOrder = Schema.Literals([
  "updated_at", "created_at", "jira_key", "manual",
]);
export const DEFAULT_SIDEBAR_FEATURE_SORT_ORDER: SidebarFeatureSortOrder = "updated_at";

// Inside ClientSettingsSchema:
sidebarViewMode: SidebarViewMode
  .pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_VIEW_MODE))),
sidebarFeatureSortOrder: SidebarFeatureSortOrder
  .pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_FEATURE_SORT_ORDER))),
activeFeatureId: Schema.NullOr(TrimmedNonEmptyString)
  .pipe(Schema.withDecodingDefault(Effect.succeed(null))),
featureWorkspaceRoot: TrimmedString
  .pipe(Schema.withDecodingDefault(Effect.succeed(""))), // empty => platform default
```

---

## 4. Sidebar UI plan

### Toggle placement
`SidebarChromeHeader` at `apps/web/src/components/Sidebar.tsx:2341-2381`. Add a new `FeatureViewModeToggle` (two-icon segmented control: Repos / Features) immediately to the right of the `T3Wordmark`. Binds to `sidebarViewMode` via `useSettings()` + `useUpdateSettings()` (already imported in this file).

### Branch the body
At the top of `SidebarProjectsContent` (component used at Sidebar.tsx:3286), branch on `sidebarViewMode`:
- `"repo"` — existing code path unchanged.
- `"feature"` — render new `<SidebarFeaturesContent />` inside the same `SidebarGroup`, keeping outer shell / dnd-context / command palette intact.

### Feature grouping
New `apps/web/src/logicalFeature.ts` mirrors `apps/web/src/logicalProject.ts:108-124`. Exposes `deriveLogicalFeatureKey(thread)`:
1. If `thread.featureId` set → key = `feature:<featureId>`.
2. Else fall back to `deriveLogicalProjectKey` so orphan threads render in a "Unlinked threads" virtual feature.

Replace `threadsByProjectKey` map computation at Sidebar.tsx:2787-2958 with a `threadsByFeatureKey` computed analogously when in feature mode. Feed features into the existing `sortProjectsForSidebar` adapter by wrapping each feature as `{ id, memberProjects: repoLinks.map(...) }` — manual/updated_at/created_at sorting comes for free. Only `jira_key` sort is new and trivial.

### New components (`apps/web/src/components/sidebar/`)
- `FeatureViewModeToggle.tsx` — segmented control.
- `SidebarFeaturesContent.tsx` — feature-mode body.
- `SidebarFeatureItem.tsx` — feature row: JIRA key badge, title, status chip, repo count, expand/collapse.
- `SidebarFeatureThreadGroup.tsx` — per-task block: coordinator at top, children indented (reuses existing `ThreadRow`).
- `FeatureCreateDialog.tsx` — JIRA key, title, summary, multi-select of existing projects.
- `FeatureEditDialog.tsx`.
- `FeatureRepoLinkPicker.tsx`.
- `FeatureRefinementDialog.tsx` — pick coordinator model, linked repos to attach as children, plugin id.
- `FeatureExecutionDialog.tsx` — table of repo→{threadTitle, model}; defaults parsed from `refinement.md`.

### Selectors (`apps/web/src/store.ts` + new `apps/web/src/hooks/useFeatures.ts`)
- `useFeatureList()`, `useFeatureTasks(featureId)`, `useThreadsByFeatureKey()`, `useActiveFeatureId()` / `useSetActiveFeature()`.

---

## 5. Feature workspace on disk

Resolve via `apps/server/src/featureWorkspace.ts` (new, mirrors `apps/server/src/attachmentStore.ts`), with precedence:
1. `clientSettings.featureWorkspaceRoot` if non-empty.
2. Server-side `addProjectBaseDirectory` (`settings.ts:~L135`) + `/features`.
3. Platform default — macOS: `~/Library/Application Support/t3code/features`; others: `os.homedir() + /t3code/features`.

Per-feature directory created lazily on first `feature-task.start.*`:
```
<root>/<slug(jiraKey ?? featureId)>/
  feature.json     # snapshot of Feature metadata
  refinement.md    # output written by coordinator
  plan.md          # optional hand-authored or coordinator-emitted plan
  notes/           # coordinator scratch
  .t3/             # exported child transcripts
```

This directory is represented server-side as a hidden `OrchestrationProject` with the new `kind = 'feature-workspace'` column (migration 027) so the coordinator thread can use the existing `projectId`-required command schema without relaxing invariants. Hidden projects are filtered out of the repo-mode sidebar.

---

## 6. Tech refinement flow

1. `FeatureRefinementDialog` submits `feature-task.start.refinement` (HTTP/WS pipeline unchanged).
2. `apps/server/src/orchestration/decider.ts` (switch near L88) handles the command by emitting atomically:
   - `thread.created` for the coordinator — `projectId = feat-proj:<featureId>` (hidden project), `featureId` set, `threadRole="coordinator"`, `threadAccessMode="read-write"`, cwd = `feature.workspaceDir`.
   - `thread.created` for each linked-repo child — `projectId` = target repo's project, `featureId` set, `parentThreadId` = coordinator id, `threadRole="child"`, `threadAccessMode="read-only"`.
   - `feature-task.started` tying them.
3. `ProviderCommandReactor` (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`) starts each session through the existing `CopilotAdapter.startSession` path. The plugin's `coordinatorDeveloperInstructions` / `childDeveloperInstructions` are piped through a new `developerInstructions` field on `ProviderSessionStartInput` (`packages/contracts/src/provider.ts`) — Codex already consumes developer instructions, so the plumb is partial.
4. Read-only enforcement: (a) prompt instructs "no edits, no shell writes", (b) the approval UI default-denies any write permission request for child sessions with `threadAccessMode="read-only"`. Zero hard sandbox today (see §9 risks).
5. New `apps/server/src/feature/Services/FeatureRefinementCoordinator.ts` runs the plugin's `steps` sequentially. Per-step targeting:
   - `target: "coordinator"` → server `sendTurn` to coordinator thread.
   - `target: "all-children"` → parallel `sendTurn` to each child.
   - `target: "each-child-sequential"` → serialized.
6. Final step's coordinator turn writes `<workspaceDir>/refinement.md` via its file-edit tool. When the file appears, server sets `FeatureTask.outputDocPath` and flips status to `completed`; `Feature.status → "refined"`.

---

## 7. Code execution flow

1. `FeatureExecutionDialog` (available once `refinement.md` exists) shows rows `{repo, threadTitle, model}` — defaults parsed from a "## Repos" section in `refinement.md`, fallback is one row per `FeatureRepoLink`.
2. Submits a single `feature-task.start.execution` command. `decider.ts` emits:
   - `feature-task.started` with `coordinatorThreadId = null` (execution tasks have no coordinator).
   - One `thread.created` per row — `projectId` = the repo's project, `featureId` set, `threadRole="child"`, `parentThreadId=null`, `threadAccessMode="read-write"`.
3. Each child starts via existing provider path — Copilot runs in the repo's cwd and picks up repo-local `.copilot/` / `AGENTS.md` / skills automatically.
4. Monitoring: feature row expands to a table of child threads with live `ThreadStatusIndicators` (reuse `apps/web/src/components/ThreadStatusIndicators.tsx`). Clicking any row opens that thread normally.
5. Concurrency: client-side constant `MAX_CONCURRENT_EXECUTION_SESSIONS = 5`, dispatch staged client-side. See §9 risk 4.

---

## 8. Plugin hook + JIRA connector stub

### Refinement plugin (narrow, not a framework)

`apps/server/src/provider/FeatureRefinementPlugins.ts`:
```ts
export interface RefinementPluginContext {
  readonly feature: Feature;
  readonly coordinatorThreadId: ThreadId;
  readonly childThreads: ReadonlyArray<{ threadId: ThreadId; projectId: ProjectId; cwd: string }>;
}
export interface RefinementSkillStep {
  readonly id: string;
  readonly description: string;
  readonly target: "coordinator" | "all-children" | "each-child-sequential";
  readonly buildPrompt: (ctx: RefinementPluginContext, target: ThreadId) => Effect.Effect<string>;
}
export interface RefinementPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly coordinatorDeveloperInstructions: string;
  readonly childDeveloperInstructions: string;
  readonly steps: ReadonlyArray<RefinementSkillStep>;
}
export const REFINEMENT_PLUGINS = new Map<string, RefinementPlugin>();
```

Ship one default plugin `copilot.refinement.v1` at `apps/server/src/provider/plugins/CopilotRefinementV1.ts` with hardcoded steps: (1) discover services & entry points → each child, (2) summarize data model → each child, (3) synthesize cross-repo plan → coordinator (writes `refinement.md`). Same style as the existing `apps/server/src/provider/CodexDeveloperInstructions.ts`. Authors add new plugins by dropping a file and registering it in `REFINEMENT_PLUGINS`.

### JIRA connector

`packages/contracts/src/jira.ts`:
```ts
export interface JiraIssueSummary {
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string | null;
  readonly assignee: string | null;
  readonly labels: ReadonlyArray<string>;
}
export interface JiraConnector {
  readonly id: string;             // e.g. "manual", "jira-cloud"
  readonly displayName: string;
  readonly fetchIssue: (key: string) => Effect.Effect<JiraIssueSummary, JiraConnectorError>;
  readonly validateKey: (key: string) => boolean;
}
```

Server registry at `apps/server/src/integrations/JiraConnectorRegistry.ts` ships only the `manual` connector (no network; returns `{ key, title: "(not loaded)", ... }`). `Feature.jiraConnectorId` records which connector populated the entry. Adding a real Jira Cloud connector later requires no schema changes.

---

## 9. Files to create / modify

### Create
- `packages/contracts/src/jira.ts`
- `packages/contracts/src/features.ts` *(optional split — otherwise inline in `orchestration.ts`; recommend split)*
- `apps/server/src/persistence/Migrations/026_FeatureMode.ts`
- `apps/server/src/persistence/Migrations/027_ProjectionThreadsFeatureColumns.ts`
- `apps/server/src/persistence/Services/ProjectionFeatures.ts`
- `apps/server/src/persistence/Services/ProjectionFeatureRepoLinks.ts`
- `apps/server/src/persistence/Services/ProjectionFeatureTasks.ts`
- `apps/server/src/featureWorkspace.ts`
- `apps/server/src/feature/Services/FeatureRefinementCoordinator.ts`
- `apps/server/src/provider/FeatureRefinementPlugins.ts`
- `apps/server/src/provider/plugins/CopilotRefinementV1.ts`
- `apps/server/src/integrations/JiraConnectorRegistry.ts`
- `apps/web/src/logicalFeature.ts`
- `apps/web/src/hooks/useFeatures.ts`
- `apps/web/src/components/sidebar/FeatureViewModeToggle.tsx`
- `apps/web/src/components/sidebar/SidebarFeaturesContent.tsx`
- `apps/web/src/components/sidebar/SidebarFeatureItem.tsx`
- `apps/web/src/components/sidebar/SidebarFeatureThreadGroup.tsx`
- `apps/web/src/components/sidebar/FeatureCreateDialog.tsx`
- `apps/web/src/components/sidebar/FeatureEditDialog.tsx`
- `apps/web/src/components/sidebar/FeatureRepoLinkPicker.tsx`
- `apps/web/src/components/sidebar/FeatureRefinementDialog.tsx`
- `apps/web/src/components/sidebar/FeatureExecutionDialog.tsx`

### Modify
- `packages/contracts/src/orchestration.ts` — ids, extended thread(Shell), commands, events, read model
- `packages/contracts/src/settings.ts` — `sidebarViewMode`, related fields (schema + patch)
- `packages/contracts/src/provider.ts` — optional `developerInstructions` on `ProviderSessionStartInput`
- `apps/server/src/orchestration/decider.ts` — handle new commands
- `apps/server/src/orchestration/projector.ts` — project new events
- `apps/server/src/orchestration/Normalizer.ts` — normalize new commands
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` — route new commands
- `apps/server/src/orchestration/commandInvariants.ts` — invariants (can't delete feature with active tasks, can't link same repo twice)
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — spawn coordinator + children, pipe plugin developer instructions
- `apps/server/src/persistence/Services/ProjectionThreads.ts` — new thread columns
- `apps/server/src/persistence/Services/ProjectionProjects.ts` — new `kind` column, filter in repo list
- `apps/server/src/provider/Services/ProviderAdapter.ts` — accept developer instructions
- `apps/web/src/components/Sidebar.tsx` — mount toggle in `SidebarChromeHeader` (L2341-2381), branch `SidebarProjectsContent` body on `sidebarViewMode`
- `apps/web/src/store.ts` — feature snapshot selectors
- `apps/web/src/uiStateStore.ts` — feature expand/collapse state (mirror `projectExpandedById`)

---

## 10. Phased rollout (each phase is shippable)

- **Phase A — Grouping skeleton.** Contracts for `Feature`/`FeatureRepoLink`; migrations 026 + 027; `sidebarViewMode` setting; `FeatureViewModeToggle`; `FeatureCreateDialog` + `FeatureRepoLinkPicker`; feature-mode sidebar body with manual "Assign to feature" action on existing threads. No tasks yet. Immediately useful: users can organize existing threads by feature.
- **Phase B — Refinement coordinator.** Feature workspace on disk; hidden `feature-workspace` project kind; coordinator thread lifecycle; `FeatureTask`; `FeatureRefinementDialog`; developer-instructions plumbing through `ProviderSessionStartInput`; read-only child threads; `FeatureRefinementCoordinator` step runner.
- **Phase C — Execution fan-out.** `FeatureExecutionDialog`; `feature-task.start.execution`; expandable child-thread table in feature row; client-side concurrency guard.
- **Phase D — Plugin hook + JIRA stub.** `REFINEMENT_PLUGINS` map with `copilot.refinement.v1`; `JiraConnector` interface + `manual` connector; JIRA key regex validation in dialog.

---

## 11. Verification / test plan

### Unit tests (follow existing `.test.ts` conventions)
- `apps/server/src/orchestration/decider.feature.test.ts` — each new command emits expected events; invariants fire (no duplicate repo link, can't delete feature with active tasks, coordinator+children emitted atomically).
- `apps/server/src/orchestration/projector.feature.test.ts` — events update `projection_features` / `projection_feature_repo_links` / `projection_feature_tasks` / new `projection_threads` columns.
- `apps/server/src/featureWorkspace.test.ts` — path precedence; idempotent directory creation.
- `apps/server/src/persistence/Migrations/026_FeatureMode.test.ts` and `027_*.test.ts` — mirror `024_BackfillProjectionThreadShellSummary.test.ts` pattern; verify idempotent ALTER TABLE.
- `apps/web/src/logicalFeature.test.ts` — feature-mode key derivation + orphan fallback.
- `apps/web/src/components/Sidebar.logic.test.ts` additions — feature-mode render branch.

### Manual QA per phase

**Phase A**
1. Toggle sidebar to Features → empty state shows "Create your first feature".
2. Create feature `ENG-123`, link 2 existing repo projects → 2-repo chip visible.
3. On an existing thread, use "Assign to feature" → ENG-123. Toggle to Features → thread appears under the feature.
4. Toggle back to Repos → thread still visible under its repo. `sidebarViewMode` persists across restart.

**Phase B**
5. Click "Refine" on feature → pick model, confirm.
6. Sidebar shows coordinator + 2 read-only children. Coordinator cwd = feature workspace; each child cwd = its repo.
7. Coordinator completes → `<workspace>/refinement.md` exists. Feature status flips to `refined`.

**Phase C**
8. Click "Execute" → dialog pre-fills 2 rows from `refinement.md` "## Repos" section. Submit.
9. 2 concurrent child sessions spawn in each repo's cwd; each picks up local `AGENTS.md`. Live status indicators update.
10. Cancel one child from its row → its session stops, task still `running`.

**Phase D**
11. `FeatureCreateDialog` JIRA key rejects malformed values; valid keys stored with `jiraConnectorId = "manual"`.
12. Swap in a stub `jira-cloud` connector that returns a fixed title → title auto-populates on key entry.

---

## 12. Open risks / unknowns

1. **Feature workspace root on macOS** — propose `~/Library/Application Support/t3code/features` vs `~/t3code/features`. Affects iCloud behavior and backups. Confirm with user.
2. **Read-only Copilot sessions** — `@github/copilot-sdk` has no dedicated read-only mode. Relying on prompt + approval-UI default-deny may cause noisy approval prompts during refinement. Spike worthwhile; fallback is a macOS/Linux read-only bind mount.
3. **Coordinator driving children** — `ProviderAdapter.sendTurn` is per-thread. Needed cross-thread dispatch is new; proposed server-side `FeatureRefinementCoordinator` keeps the capability out of adapters but introduces one privileged module. Alternative (coordinator issues tool calls to a child-RPC tool) is riskier.
4. **Execution concurrency limit** — `MAX_CONCURRENT_EXECUTION_SESSIONS = 5` constant-in-code for now; matters for features spanning 20+ repos. Settings-driven later.
5. **Hidden `feature-workspace` project rows** — adding `projection_projects.kind` column is the simplest path; alternative of making `OrchestrationThread.projectId` nullable has much larger blast radius.
6. **JIRA key uniqueness** — soft warning rather than a hard invariant, so users can re-use keys intentionally. Confirm.
7. **Plugin versioning** — `FeatureTask.pluginId` pins the version; in-flight tasks always finish on the pinned version regardless of newer plugins shipping.
8. **Multi-provider coordinator** — spec defaults to Copilot. `RefinementPlugin` is provider-agnostic, but only `CopilotRefinementV1` ships. Decide whether to also ship `ClaudeRefinementV1` / `CodexRefinementV1` at launch.
