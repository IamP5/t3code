# Feature Mode — Foundation (Spec 1)

**Date:** 2026-04-20
**Status:** Draft — pending user review
**Supersedes (in part):** `.docs/feature-mode-plan.md`
**Successor spec:** Spec 2 — Code execution fan-out (not yet written)

---

## 1. Context

Today t3code models one **project = one repo**; every `OrchestrationThread` has a required `projectId` pointing to an `OrchestrationProject` (`packages/contracts/src/orchestration.ts:184-340`). The sidebar groups threads by project using `deriveLogicalProjectKey` (`apps/web/src/logicalProject.ts:108-124`).

Enterprise teams working across many micro-services / micro-frontends need to group their work by a **feature** (usually identified by a JIRA ticket) rather than by repo. Today they either open many parallel threads and track the association in their head, or lose context switching between repos.

**Outcome for Spec 1:** a client-side **sidebar view toggle** (Repos ⇄ Features) that overlays the existing repo model with a thin `Feature` layer, plus the CRUD surface to create features, link repos to them, and assign threads. This is a pure organization layer — no new workflow, no new server processes, no fan-out. It is the foundation that Spec 2 (code execution fan-out) will build on.

### Decisions confirmed during brainstorming
- **Thread ↔ feature cardinality:** one feature per thread (nullable FK).
- **Linked repos:** flat list (no primary/secondary role).
- **JIRA key:** optional, regex-validated when present (`^[A-Z][A-Z0-9]+-\d+$`). No JIRA API integration in Spec 1.
- **Feature status enum:** full 6-state lifecycle baked into the schema — `idle | exploration | refinement | breaking-us | planning | executing`. Spec 1 ships **only manual** transitions via a status dropdown. Later specs add automated transitions without schema churn. Archive is orthogonal (a separate `archivedAt` timestamp), not a status value.
- **Feature deletion:** archive-only in Spec 1. Hard delete deferred.
- **Archive semantics:** threads with `featureId` set to an archived feature stay put; the feature is hidden by default, revealed by a "Show archived" toggle.
- **Unlinked threads in Feature mode:** rendered in a virtual "Unlinked threads" group at the bottom of the sidebar, grouped by their project, always visible.
- **Create-feature CTA:** "+ Add feature" button in the Features sidebar-group header, mirroring the existing "Add Project" button.
- **"+ New thread" on a feature row:** opens the existing `ThreadCreateDialog` pre-filled with `featureId` and a repo picker narrowed to the feature's linked repos.
- **Assign existing thread to feature:** via the thread-row context menu → "Assign to feature…" → picker dialog (existing features / Unassign / Create new).

### Explicitly out of scope (handled by later specs)
- Fan-out execution (Spec 2): `FeatureTask`, child-thread primitives (`parentThreadId`, `threadRole`, `threadAccessMode`), monitoring UI, concurrency guard.
- Tech refinement coordinator, feature workspace on disk, developer-instructions plumbing, refinement plugin system — all deferred to a future refinement spec (not yet planned).
- Real JIRA API connector (stays a string in Spec 1).
- Feature sort controls (updated_at / created_at / jira_key / manual) — Spec 1 ships a single built-in sort by `updated_at desc`.
- `defaultModelSelection` on `Feature` — added when Spec 2 needs it for fan-out.
- `activeFeatureId` client setting — not load-bearing until Spec 2.
- Drag-and-drop thread → feature.
- Command-palette entry for "Create feature".

---

## 2. Data model

Edits to `packages/contracts/src/orchestration.ts`:

```ts
export const FeatureId = TrimmedNonEmptyString.pipe(Schema.brand("FeatureId"));
export type FeatureId = typeof FeatureId.Type;

export const JiraIssueKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Z][A-Z0-9]+-\d+$/),
);

export const FeatureStatus = Schema.Literals([
  "idle",
  "exploration",
  "refinement",
  "breaking-us",
  "planning",
  "executing",
]);
export type FeatureStatus = typeof FeatureStatus.Type;
export const DEFAULT_FEATURE_STATUS: FeatureStatus = "idle";

export const FeatureRepoLink = Schema.Struct({
  featureId: FeatureId,
  projectId: ProjectId,
  addedAt: IsoDateTime,
});

export const Feature = Schema.Struct({
  id: FeatureId,
  jiraKey: Schema.NullOr(JiraIssueKey),
  title: TrimmedNonEmptyString,
  summary: Schema.NullOr(TrimmedString),
  status: FeatureStatus,                       // defaults to "idle"
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  repoLinks: Schema.Array(FeatureRepoLink),    // denormalized for read model
});
```

Extend `OrchestrationThread` (L316-340) and `OrchestrationThreadShell` (L362-383) with one optional field — `withDecodingDefault` so existing projections decode unchanged:

```ts
featureId: Schema.NullOr(FeatureId)
  .pipe(Schema.withDecodingDefault(Effect.succeed(null))),
```

Extend `OrchestrationReadModel` and `OrchestrationShellSnapshot` (L342-391):
```ts
features: Schema.Array(Feature),
```

Shell stream events: add `feature-upserted` and `feature-removed`.

`OrchestrationAggregateKind` gains `"feature"`; `EventBaseFields.aggregateId` widens to `Schema.Union([ProjectId, ThreadId, FeatureId])`.

---

## 3. Commands and events

### New commands
Appended to the command union near L465-499 in `orchestration.ts`:

| Command | Payload |
|---|---|
| `feature.create` | `{ featureId, jiraKey?, title, summary?, status, createdAt, initialRepoLinks: ProjectId[] }` |
| `feature.meta-update` | `{ featureId, title?, jiraKey?, summary?, status? }` |
| `feature.archive` | `{ featureId }` |
| `feature.unarchive` | `{ featureId }` |
| `feature.repo-link.add` | `{ featureId, projectId, addedAt }` |
| `feature.repo-link.remove` | `{ featureId, projectId }` |
| `thread.assign-feature` | `{ threadId, featureId: FeatureId \| null }` |

`feature.create` with `initialRepoLinks` emits one `feature.created` plus N `feature.repo-linked` events in one atomic batch (see `decider.ts`).

### New events
`feature.created`, `feature.meta-updated`, `feature.archived`, `feature.unarchived`, `feature.repo-linked`, `feature.repo-unlinked`, `thread.feature-assigned`.

### Invariants (`apps/server/src/orchestration/commandInvariants.ts`)
In all invariants, "archived" means `archivedAt IS NOT NULL`; "non-archived" means `archivedAt IS NULL`.

- `feature.repo-link.add`: cannot link same `(featureId, projectId)` pair twice.
- `feature.archive`: feature must be non-archived.
- `feature.unarchive`: feature must be archived.
- `thread.assign-feature`: target `featureId` (when non-null) must exist and be non-archived.
- `feature.meta-update`: target feature must be non-archived (edits on archived features rejected; unarchive first).

---

## 4. Settings

Edits to `packages/contracts/src/settings.ts` (after L34; inside `ClientSettingsSchema` L36-62 and mirror in `ClientSettingsPatch` L296-316):

```ts
export const SidebarViewMode = Schema.Literals(["repo", "feature"]);
export type SidebarViewMode = typeof SidebarViewMode.Type;
export const DEFAULT_SIDEBAR_VIEW_MODE: SidebarViewMode = "repo";

// inside ClientSettingsSchema:
sidebarViewMode: SidebarViewMode
  .pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_VIEW_MODE))),
```

No server-side settings. No feature-sort setting. No archived-visibility setting (the "Show archived" toggle is UI state, kept in `uiStateStore`).

---

## 5. Migrations

Latest existing: `025_CleanupInvalidProjectionPendingApprovals.ts`. New migrations are `026` and `027`.

### `apps/server/src/persistence/Migrations/026_FeatureMode.ts`
```sql
CREATE TABLE IF NOT EXISTS projection_features (
  feature_id TEXT PRIMARY KEY,
  jira_key TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_projection_features_updated_at ON projection_features(updated_at);
CREATE INDEX idx_projection_features_jira_key ON projection_features(jira_key)
  WHERE jira_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS projection_feature_repo_links (
  feature_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (feature_id, project_id)
);
CREATE INDEX idx_projection_feature_repo_links_project
  ON projection_feature_repo_links(project_id);
```

### `apps/server/src/persistence/Migrations/027_ProjectionThreadsFeatureId.ts`
```sql
ALTER TABLE projection_threads ADD COLUMN feature_id TEXT;
CREATE INDEX idx_projection_threads_feature_id ON projection_threads(feature_id)
  WHERE feature_id IS NOT NULL;
```

No data backfill: existing threads default to `feature_id = NULL`, and `sidebarViewMode` defaults to `"repo"`, so existing users see zero behavioral change until they opt into Feature mode.

---

## 6. UI surface

### 6.1 Toggle placement
`FeatureViewModeToggle` — a 2-button segmented control mounted inside `SidebarChromeHeader` (`apps/web/src/components/Sidebar.tsx:2341-2381`), to the right of the `T3Wordmark`.
- Icon set: Lucide `GitBranch` (Repos) / `Layers` (Features).
- Binds to `sidebarViewMode` via `useSettings()` + `useUpdateSettings()`.
- Immediate re-render; no confirmation dialog.

### 6.2 Sidebar body in Feature mode
Branch at the top of `SidebarProjectsContent` (used at `Sidebar.tsx:3286`) on `sidebarViewMode`:
- `"repo"` → existing render path (unchanged).
- `"feature"` → new `<SidebarFeaturesContent />` inside the same `SidebarGroup`, keeping outer shell / dnd-context / command palette / footer intact.

Layout of `SidebarFeaturesContent`:
```
SidebarGroup "Features"
  header: "Features" label, "+ Add feature" button (mirrors "Add Project")
  body:
    SidebarFeatureItem × N   (sorted by updated_at desc; archived hidden unless "Show archived" on)
      collapsed row: [status dot] [JIRA key badge?] [title] [repo count] [⋮]
      expanded:
        linked-repo chips (click to filter threads under this feature by repo; visual only in Spec 1)
        thread list (reuses ThreadRow)
        "+ New thread" button
    ──────────────────────────────
    SidebarUnlinkedThreadsGroup   (always present, starts collapsed after first toggle)
      renders existing projects and their featureId=null threads using the existing
      SidebarProjectItem / SidebarProjectThreadList components
```

Expand/collapse state per-feature and for the Unlinked group is persisted in `uiStateStore`: new record `featureExpandedById: Record<string, boolean>` mirroring the existing `projectExpandedById`.

"Show archived" is a Zustand-local toggle inside `SidebarFeaturesContent`, persisted via `uiStateStore` as a single boolean.

### 6.3 New components
Under `apps/web/src/components/sidebar/`:

| Component | Purpose |
|---|---|
| `FeatureViewModeToggle.tsx` | Segmented toggle in sidebar header |
| `SidebarFeaturesContent.tsx` | Body for Feature mode |
| `SidebarFeatureItem.tsx` | One feature row + expanded content (linked-repos chips + threads + "+ New thread") |
| `SidebarUnlinkedThreadsGroup.tsx` | Wraps existing repo-mode rendering filtered to `featureId = null` |
| `FeatureCreateDialog.tsx` | Title, optional JIRA key, summary, multi-select of existing projects |
| `FeatureEditDialog.tsx` | Same fields + status dropdown (6 values) + linked-repo manager |
| `FeatureRepoLinkPicker.tsx` | Multi-select of existing `OrchestrationProject`s, embedded in create/edit dialogs |
| `FeatureStatusChip.tsx` | Color-coded chip for the 6 lifecycle states; renders a muted "archived" badge alongside when `archivedAt` is set |
| `FeatureContextMenu.tsx` | `⋮` on a feature row: Edit, Archive/Unarchive |
| `ThreadAssignToFeatureDialog.tsx` | Opened from thread-row context menu: pick feature / Unassign / Create new |

### 6.4 Reused components
- `ThreadCreateDialog` — accepts optional `featureId` and a filtered list of eligible projects.
- `ThreadRow`, `SidebarProjectItem`, `SidebarProjectThreadList` — used inside `SidebarUnlinkedThreadsGroup` without modification.
- The existing thread-row context menu gains one new entry: **Assign to feature…**

### 6.5 State and selectors
Additions to `apps/web/src/store.ts`:
- `useFeatureList()` — sorted features from the shell snapshot.
- `useFeatureById(featureId)`.
- `useThreadsByFeatureKey()` — map of `featureKey → Thread[]` for the feature-mode render pass (includes the virtual `"unlinked:<projectKey>"` keys used by `SidebarUnlinkedThreadsGroup`).

Additions to `apps/web/src/uiStateStore.ts`:
- `featureExpandedById: Record<string, boolean>`
- `showArchivedFeatures: boolean`
- `unlinkedThreadsGroupExpanded: boolean`

New grouping helper `apps/web/src/logicalFeature.ts` (mirrors `apps/web/src/logicalProject.ts:108-124`):
```ts
export function deriveLogicalFeatureKey(thread: Pick<Thread, "featureId" | "projectId" | "environmentId">): string {
  if (thread.featureId !== null) return `feature:${thread.featureId}`;
  return `unlinked:${deriveLogicalProjectKey(thread)}`;  // fall back to existing repo grouping
}
```

---

## 7. User flows

### Flow 1 — Create a feature
Sidebar → toggle to Features → "+ Add feature" → `FeatureCreateDialog` → fill title, optional JIRA key, optional summary, pick linked repos → Submit.
Dispatches a single `feature.create` command (with `initialRepoLinks: ProjectId[]`) that the decider fans out into `feature.created` + N × `feature.repo-linked` events in one batch. New feature appears at the top of the list with status `"idle"`.

### Flow 2 — Create a new thread under a feature
Expand a feature → "+ New thread" on the feature row → existing `ThreadCreateDialog` opens pre-filled with `featureId` and a repo picker narrowed to the feature's linked repos. User picks repo, enters title, model → Submit. A standard `thread.create` command flows through, but with `featureId` set on the thread at creation time.

### Flow 3 — Assign an existing thread to a feature
Right-click thread row → context menu → "Assign to feature…" → `ThreadAssignToFeatureDialog` → pick an existing feature / "Unassign" / "Create new feature…" → Submit.
Dispatches `thread.assign-feature`. Sidebar re-groups. A future sort pass on the thread may move it visually; thread timestamps are unchanged.

### Flow 4 — Edit / archive / unarchive a feature
Feature row Feature row `⋮` → Edit → `FeatureEditDialog` (title, summary, JIRA key, status dropdown with 6 lifecycle values, linked-repo manager). Submit emits `feature.meta-update` plus link add/remove deltas.
`⋮` → Archive → `feature.archive`. Feature disappears from the list; reappears under a "Show archived" toggle.
`⋮` → Unarchive → `feature.unarchive`.

### Flow 5 — Toggle back to Repo mode
Toggle button → sidebar re-renders with existing repo-mode logic. Any open thread stays open. `sidebarViewMode` persists across reloads.

---

## 8. Files

### Create (server)
- `apps/server/src/persistence/Migrations/026_FeatureMode.ts`
- `apps/server/src/persistence/Migrations/026_FeatureMode.test.ts`
- `apps/server/src/persistence/Migrations/027_ProjectionThreadsFeatureId.ts`
- `apps/server/src/persistence/Migrations/027_ProjectionThreadsFeatureId.test.ts`
- `apps/server/src/persistence/Services/ProjectionFeatures.ts`
- `apps/server/src/persistence/Services/ProjectionFeatureRepoLinks.ts`

### Create (web)
- `apps/web/src/logicalFeature.ts`
- `apps/web/src/hooks/useFeatures.ts`
- `apps/web/src/components/sidebar/FeatureViewModeToggle.tsx`
- `apps/web/src/components/sidebar/SidebarFeaturesContent.tsx`
- `apps/web/src/components/sidebar/SidebarFeatureItem.tsx`
- `apps/web/src/components/sidebar/SidebarUnlinkedThreadsGroup.tsx`
- `apps/web/src/components/sidebar/FeatureCreateDialog.tsx`
- `apps/web/src/components/sidebar/FeatureEditDialog.tsx`
- `apps/web/src/components/sidebar/FeatureRepoLinkPicker.tsx`
- `apps/web/src/components/sidebar/FeatureStatusChip.tsx`
- `apps/web/src/components/sidebar/FeatureContextMenu.tsx`
- `apps/web/src/components/sidebar/ThreadAssignToFeatureDialog.tsx`

### Modify
- `packages/contracts/src/orchestration.ts` — ids, Feature schemas, commands, events, extended thread(Shell), read model
- `packages/contracts/src/settings.ts` — `sidebarViewMode`
- `apps/server/src/orchestration/decider.ts` — handle new commands
- `apps/server/src/orchestration/projector.ts` — project new events
- `apps/server/src/orchestration/Normalizer.ts` — normalize new commands
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` — route new commands
- `apps/server/src/orchestration/commandInvariants.ts` — invariants
- `apps/server/src/persistence/Services/ProjectionThreads.ts` — new `feature_id` column
- `apps/web/src/components/Sidebar.tsx` — mount toggle in `SidebarChromeHeader` (L2341-2381); branch `SidebarProjectsContent` body on `sidebarViewMode`; add "Assign to feature…" to thread-row context menu
- `apps/web/src/store.ts` — feature snapshot selectors
- `apps/web/src/uiStateStore.ts` — `featureExpandedById`, `showArchivedFeatures`, `unlinkedThreadsGroupExpanded`

---

## 9. Testing

### Unit (server)
- `apps/server/src/orchestration/decider.feature.test.ts` — each new command emits the expected event; `feature.create` with `initialRepoLinks` emits `feature.created` + N × `feature.repo-linked` atomically; invariants fire for duplicate link, archive-while-archived, assign to missing/archived feature.
- `apps/server/src/orchestration/projector.feature.test.ts` — events upsert `projection_features` / `projection_feature_repo_links` correctly; `thread.feature-assigned` updates `projection_threads.feature_id`; archive flips `archived_at`.
- `apps/server/src/persistence/Migrations/026_FeatureMode.test.ts` and `027_ProjectionThreadsFeatureId.test.ts` — mirror `024_BackfillProjectionThreadShellSummary.test.ts`; verify idempotent DDL.

### Unit (web)
- `apps/web/src/logicalFeature.test.ts` — `featureId` set → `feature:<id>`; null → `unlinked:<projectKey>` fallback.
- `apps/web/src/components/Sidebar.logic.test.ts` additions — feature-mode render branch produces expected grouping (features + Unlinked group) and respects archived-visibility toggle.

### Manual QA
1. Fresh app, toggle to Features → empty state "Create your first feature" visible, `FeatureViewModeToggle` visible.
2. Create feature `ENG-123` "Checkout refactor" linking 2 existing repo projects → feature appears at top with 2-repo chip, status "idle".
3. Every pre-existing thread appears in the "Unlinked threads" group at the bottom, grouped by project. Nothing is hidden.
4. Right-click an existing thread → "Assign to feature…" → pick ENG-123 → thread moves under ENG-123 and disappears from Unlinked.
5. Expand ENG-123 → "+ New thread" → `ThreadCreateDialog` opens with repo picker restricted to ENG-123's 2 linked repos. Submit → thread appears under ENG-123.
6. Toggle to Repos → newly-created thread renders under its repo project. Toggle back → state persists across reload.
7. Feature row `⋮` → Edit → change status "idle" → "planning" → status chip updates; change "+ link repo" → new repo link dispatched.
8. `⋮` → Archive → feature disappears; "Show archived" toggle reveals it with an archived indicator (status chip unchanged; a muted "archived" badge renders next to it). Unarchive → returns to active list.
9. Try to assign a thread to an archived feature via the picker → archived features are not offered (filter test).
10. Hard-delete UI is not present anywhere. Confirm there is no "Delete feature" menu item.

---

## 10. Open risks / deferred items

1. **Hard delete:** archive-only in Spec 1. If a feature needs to be scrubbed for legal / privacy reasons, that's a manual DB op in Spec 1. Add a proper hard-delete command in a follow-up if needed.
2. **Feature sort controls:** Spec 1 ships `updated_at desc` only. Add sort controls (manual / created_at / jira_key) in a later spec if users ask. `SidebarFeatureSortOrder` literal can be added without migration.
3. **Archived-feature visibility:** the "Show archived" toggle is UI-local. Persisting it across devices requires promoting it to `ClientSettings`; deferred.
4. **Reactivating an archived thread whose feature was archived:** the thread stays linked to the archived feature. If the user wants to surface it in Feature mode they must first unarchive the feature. Confirm this is acceptable UX.
5. **Command batching:** `feature.create` carrying `initialRepoLinks` is implemented as a single command that fans into multiple events in the decider. If you prefer strictly one-command-one-event, we split into `feature.create` + explicit `feature.repo-link.add` from the client (two round trips). Spec picks the batched form for atomicity and fewer roundtrips.
6. **Where "Create new feature…" is wired from the thread-assign dialog:** opens `FeatureCreateDialog` in a nested modal, and on success immediately dispatches `thread.assign-feature`. Nested modal UX is slightly awkward but avoids losing the thread-assign intent.

---

## 11. Ready for Spec 2

After Spec 1 lands, Spec 2 ("Code execution fan-out") will add:
- `FeatureTask` entity (kind = `"execution"` initially).
- Child-thread primitives: `parentThreadId`, `threadRole`, `threadAccessMode` columns on threads.
- `feature-task.start.execution` command → spawns N child threads, one per repo link.
- Monitoring UI inside the expanded feature row.
- Concurrency guard (`MAX_CONCURRENT_EXECUTION_SESSIONS`).
- Auto-transition to `"executing"` status on task start; back to `"planning"` on task complete.

Nothing in Spec 1's data model blocks Spec 2 — every new column Spec 2 needs is additive.
