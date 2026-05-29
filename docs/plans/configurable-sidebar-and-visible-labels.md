# Configurable sidebar + visible stream labels

Branch: `claude/stoic-cori-PnIXF`. Delivered as a **stack of small PRs**, not one
god PR. This doc is the source of truth for the whole initiative.

## Goal

Labels (color + title + emoji) exist as a complete data layer but have no visual
surface. Make them visible:

1. **Sidebar** — labels become grouping sections, via a newly **configurable
   sidebar** (the two presets become editable default configs).
2. **Stream top bar** — a compact stack of label chips.

## Locked product/architecture decisions

- **Sidebar model:** a per-user, per-workspace **sidebar config** = an ordered
  list of typed **sections**. **Every section is an independent filter** (each
  smart bucket, each stream type, each label is its own reorderable section).
- **Overlap:** each section carries a **`hideAboveShown`** flag (ON by default).
  With it on, a stream renders only in the first matching section (reproduces
  today). Turn it off to make a section an **additive lens** (e.g. a label
  section that shows streams even if shown above). A **`remainder`** section
  kind renders "everything not shown above" (today's "Everything Else").
- **Presets → default seed configs:** `Smart = [important, recent, pinned,
remainder]`, `All = [type:scratchpads, type:channels, type:dms]`. New users
  seed from Smart; existing users seed from their current `viewMode`. "Reset to
  preset" restores a seed.
- **Editor:** both — inline quick add/remove (label picker, section-header menu,
  labels page) **plus** a roomy "Sidebar" settings panel for drag-reorder/reset.
- **Label model:** **unify membership** — creator gets a `label_members` row on
  every label (private + public); backfill existing private labels.
  `creator_user_id` still owns edit/delete. **Lifecycle:** `leave()` removes
  only the caller's row; the label is archived only when the **last** member
  leaves (race-safe, single transaction) or someone explicitly archives it.
- **Top bar:** stack shows the **full public pool on the stream + the viewer's
  private labels** (already delivered by `listForViewer` → bootstrap; stays live
  via stream-room `label:assigned/unassigned` events). Deduped by label, cap ~3
  then `+N`, **desktop hover fans out** to name-pills (absolute overlay, no
  reflow — INV-21), **mobile tap → vaul drawer**. **Display-only**; editing
  stays in `LabelPicker`.
- **Visual language (shared `LabelChip`):** **tinted** — `hexToRgba(color,0.12)`
  bg, ~30% border, emoji leads, name in ink; collapsed = emoji on a tinted disc,
  **solid color dot fallback** when a label has no emoji. Shadcn + lucide only,
  no new global accent tokens (per-label authored color only, like trace hues).
  See `DESIGN.md`.

## Data shapes

```ts
// Sidebar config (per user, per workspace)
type SidebarSectionKind =
  | { kind: "smart"; bucket: "important" | "recent" | "pinned" }
  | { kind: "remainder" }
  | { kind: "type"; streamType: "scratchpad" | "channel" | "dm" }
  | { kind: "label"; labelId: string }

interface SidebarSection {
  id: string // stable ulid, e.g. sbsec_xxx
  spec: SidebarSectionKind
  hideAboveShown: boolean
  // label-display name/emoji/color resolved from the labels cache at render
}
interface SidebarConfig {
  workspaceId: string
  userId: string
  sections: SidebarSection[]
  basePreset: "smart" | "all" | "custom"
  updatedAt: string
}
```

## The PR stack

### PR1 — Config-driven sidebar rendering (no behavior change, no editor) ✅ implemented

Frontend only. Introduce the config types + a pure resolver and route the
existing sidebar through it, seeded from today's `viewMode` (no persistence yet
— configs can't diverge from presets until the editor lands).

- `sidebar/sidebar-config.ts` — `SidebarSectionSpec` (`smart` bucket | `type`),
  `SidebarConfig`, `SMART_PRESET` / `ALL_PRESET` seeds, `presetForViewMode`, and
  `sectionPresentation(spec)` (label/icon/tiered/compact/hideWhenEmpty/default
  collapse derived purely from the spec).
- `sidebar/resolve-sections.ts` — pure
  `resolveSections(config, { processedStreams, virtualDmStreams, getUnreadCount })`
  → `Array<{ section, items }>`. Reuses existing `sortStreams` and Recent's 5-cap
  / Important's 10-cap as per-section params; DM section composed as
  realDMs(activity) ++ system(alpha) ++ virtual.
- Refactor `sidebar.tsx` to build the active config + call the resolver; refactor
  `sidebar-stream-list.tsx` to render the resolved list generically (dropped the
  `viewMode` if/else branch and the dead `SmartSection`). Collapse state keyed by
  `section.id`, which equals the prior keys so persisted collapse prefs survive.
- Tests: resolver reproduces today's Smart and All buckets, caps, Recent logic,
  and DM composition (object-compare, INV-24). `bun run typecheck` + `lint` clean.

**Deviations from the model below (deferred, not dropped):** `hideAboveShown`
and the `remainder` kind are **not** in PR1. Today's buckets are mutually
exclusive (a stream is in exactly one `categorizeStream` bucket and is exactly
one type), so dedup is a no-op and a `remainder` kind would be unused — adding
either now would be speculative (INV-36). Smart's "Everything Else" is modeled as
`{ kind: "smart", bucket: "other" }` (faithful: streams capped out of Important/
Recent vanish today, they do not fall through). `hideAboveShown` + `remainder`
land in **PR4**, where additive label lenses are the first thing to exercise them.

### PR2 — Config persistence (Smart/All toggle as the writer) ✅ implemented

Shipped the full per-user persistence vertical slice: shared `SidebarConfig`
wire type in `@threa/types`, `sidebar_configs` table (one JSONB document per
(workspace, user), absent row → default Smart preset), backend feature folder
(`apps/backend/src/features/sidebar-config/`: repository + service +
Zod-validated handlers), `sidebar_config:updated` author-scoped outbox event,
`WorkspaceBootstrap.sidebarConfig`, GET/PATCH routes, and the frontend offline
mirror (Dexie `sidebarConfigs` table, store seed + `useWorkspaceSidebarConfig`,
sync handler + socket registration, `sidebarConfigApi`, `useSidebarConfig` with
optimistic write). The existing Smart/All toggle now persists the full config
server-side and syncs across devices; `viewMode` was removed from the
localStorage `SidebarProvider` (config is now the source of truth; collapse
states stay device-local).

**Deviation:** the rich editor (drag-reorder, inline add/remove kinds, a
"Sidebar" settings panel, reset-to-preset) is deferred to a later stacked PR —
it earns its place once PR4's label sections give a reason to reorder/add
sections. Persisting from the toggle keeps PR2 a reviewable slice and avoids a
speculative editor (INV-36). Existing users seed to the Smart preset on first
read rather than migrating their prior localStorage `viewMode`.

### PR3 — Label model: unified membership + lifecycle

Backend + tests only, no UI. `create()` inserts creator membership for every
label; backfill migration for existing private labels; `leave()` →
last-member-archive (race-safe). `listVisibleTo`/membership reads simplified to
the uniform set; `creator_user_id` retained for permissions.

### PR4 — Sidebar label sections + shared chip ✅ implemented

Shipped the `label` section kind end-to-end + the shared tinted `LabelChip`:

- **`LabelChip`** (`components/labels/label-chip.tsx`): tinted pill —
  `hexToRgba(color, 0.12)` bg, ~30% border, name in ink, leading `LabelGlyph`
  (emoji on a tinted disc, or a solid color dot when the label has no emoji).
  Per-label authored color only (DESIGN.md §2.2). Reused by PR5.
- **`{ kind: "label"; labelId }`** added to `SidebarSectionSpec` (`@threa/types`)
  - the backend Zod schema. Resolver filters real streams by assignment and
    sorts by activity; it's an **additive lens** — a labeled stream still appears
    in its smart/type section (the resolver never dedups, so this needs no
    `hideAboveShown`). Orphan sections (label archived) are skipped at render.
- **Tinted header**: `SectionHeader` gained an optional `titleContent`; label
  sections render the `LabelChip` there, resolved from the labels cache by id
  (so rename/recolor stays live). `sidebar.tsx` builds `labelsById` +
  `streamIdsByLabel` from the workspace caches.
- **Entry point**: a "Show in sidebar" toggle on each owned/joined label card
  (Labels page) adds/removes the section via `toggleLabelSection` →
  `useSidebarConfig().setConfig`. One deterministic section per label.
- Tests: resolver label-section (additive + empty), `toggleLabelSection`
  helpers (object-compare, INV-24). Typecheck + lint clean.

**Deviations (deferred, not dropped):** `hideAboveShown` + the `remainder` kind
remain deferred — additive label lenses work without them (no dedup), so adding
them now would be speculative (INV-36). The roomy "Sidebar" settings panel,
drag-reorder, and the label-picker / section-header-menu add paths are deferred;
the Labels-page toggle is the single add/remove surface for now.

### PR5 — Stream top-bar label stack ✅ implemented

`StreamLabelStack` (`components/labels/stream-label-stack.tsx`) in the stream
header (`pages/stream.tsx`, in the title cluster just after the title, gated
`stream && !isDraft`).
Reads the shared assignment pool via `useResourceLabelAssignments` (deduped +
active-only, live through the `label:assigned/unassigned` socket handlers).
Collapsed: up to 3 overlapping `LabelGlyph` marks + a `+N` count. Reuses the
shared chip — desktop **hover** fans out to `LabelChip` name-pills in a
`HoverCard` overlay (no layout shift, INV-21); mobile **tap** opens a vaul
`Drawer` of the same chips. Display-only — editing stays in `LabelPicker`
(its existing "Labels…" menu trigger is untouched). Renders nothing when the
stream has no labels.

Tests: collapsed cap/`+N`/aria-count + empty-state, via scoped `spyOn` on the
store hooks (INV-48). Typecheck + lint clean.

This completes the initiative: labels are now visible in both the sidebar
(PR4) and the stream top bar (PR5).

## Follow-up: Quick Links as a section + tri-state visibility + drag-to-add

A second editor pass (this branch), after the customize panel merged (#691),
deepening editability:

- **Quick Links is now a section** (`SidebarSectionSpec` gains `{ kind:
"quicklinks" }`). It sits in the same ordered list as stream/label sections, so
  the whole block is draggable to any position — or removable entirely. Its
  individual links keep their own order + visibility in `SidebarConfig.quickLinks`
  (a position-only marker in `sections`, payload in `quickLinks`), so removing and
  re-adding the block preserves the viewer's link choices. The editor renders the
  links nested under the Quick Links row with their own `DndContext` (drags don't
  bubble to the sections list). The live sidebar renders the block at its section
  position via a `quickLinksSlot` passed into `SidebarStreamList` (the sidebar owns
  the live counts, so the slot is built there, not in the list).
- **Tri-state link visibility** (`SidebarQuickLinkVisibility`: `show` / `active` /
  `hidden`) replaces the boolean `enabled`. `active` ("show when active") is valid
  only for links carrying a live signal (`SIDEBAR_QUICK_LINKS_WITH_ACTIVE_STATE`:
  drafts/saved/scheduled/activity) and renders the link only when its count > 0;
  it's coerced to `show` for signal-less links in both the helper and
  `normalizeSidebarConfig`. The editor uses a `ToggleGroup` (eye / dot / eye-off).
- **Reset preset** button next to the preset toggle.
- **Drag-to-add**: an always-visible Add tray of chips below the list. Drag a chip
  onto a position (or the empty-list dropzone) to insert there; click still
  appends. One `DndContext` handles both tray-drops and section reorders (tray ids
  carry an `add:` prefix; `addSectionAt` inserts at the drop index).
- **Always-available New button** pinned at the sidebar bottom (`SidebarFooter`),
  opening every stream flavor (scratchpad variants + channel) — a dropdown on
  desktop, a drawer on mobile — so creation no longer depends on a section's
  hover-only "+".

### Document versioning + migration (INV-20-adjacent: tolerate concurrent shapes)

`SidebarConfig` gains `version` (`SIDEBAR_CONFIG_VERSION = 2`).
`normalizeSidebarConfig` (run at every read/write/sync boundary) migrates pre-v2
documents: boolean `enabled` → `visibility`, and — only for pre-v2 docs — prepends
the quick-links section so existing users keep their links after the upgrade. At
the current version an absent block means the user deliberately removed it, so it's
left gone. The backend Zod schema accepts both the legacy (`enabled`) and current
(`visibility`) link shapes and the new `quicklinks` spec, keeping a backend-first
rollout safe. No DB migration (the doc is a per-user JSONB blob).

Tests: helper unit tests (`setQuickLinkVisibility` coercion, `cycleQuickLinkVisibility`,
`addSectionAt`), editor component tests (nested order, tri-state controls, remove
block, reset, drag-tray click-add), `quick-links` render tests (active-state gating),
service tests (v1→v2 migration, dual-shape schema), and updated resolve/sync
fixtures. Typecheck + lint + full frontend suite (2004) green.

## Cross-cutting invariants

INV-51/52 (colocate label backend, import via barrels), INV-20 (race-safe
last-member-archive + idempotent membership upsert), INV-17 (append-only
migrations), INV-21 (no layout shift on hover), INV-59 (URL-driven where
relevant), INV-60 (strip markdown in any preview), INV-24 (object-compare in
tests), INV-23 (assert event presence not counts). Tests run with
`bun run test` / `bun run test:e2e`; never ship unexecuted.

```

```
