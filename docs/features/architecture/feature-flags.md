---
title: Feature Flags
status: shipped
audience: internal
kind: subsystem
invariants: [INV-4, INV-7, INV-20, INV-56]
entry_points:
  - packages/types/src/feature-flags.ts
  - apps/control-plane/src/features/feature-flags/service.ts
  - apps/backend/src/features/feature-flags/service.ts
  - apps/frontend/src/hooks/use-feature-flags.ts
public_site: false
summary: >
  Per-user rollout switches managed from the backoffice; the control plane fans a
  resolved snapshot out to the owning region, which broadcasts it to the user's live
  sessions, so a flag flips at runtime without a deploy.
related: [architecture/outbox-pattern.md]
---

## The gist

A feature flag is a boolean looked up by string key, scoped to one user in one
workspace. Flags default to **off**; a platform admin turns one on for a specific
member from the backoffice, and the change reaches that member's running frontend
sessions within a second or two — no env vars, no redeploy. The backend resolves the
same key through the same data, so a flag means the same thing on both sides of the
stack.

Flags are deliberately temporary. The registry of keys lives in code
(`FEATURE_FLAG_KEYS` in `packages/types/src/feature-flags.ts`), and every read path
filters stored rows through it. Deleting a key from that array retires the flag
everywhere in one line — leftover database rows become inert, with no migration. A flag
that survives long in the registry is a smell.

There is no cohort logic, no percentage rollout, no environment dimension. The unit is
(workspace, user, flag) → boolean, and that's it.

## How it works

**Source of truth — control plane.** `feature_flag_overrides` stores one row per
(workspace, WorkOS user, flag key); absence of a row means the default (off). The
backoffice workspace detail page gets a "Feature flags" tab (members × flags toggle
grid) backed by `GET`/`PUT /api/backoffice/workspaces/:id/feature-flags`, both gated by
`requirePlatformAdmin`. Turning a flag off from the UI _clears_ the override rather
than storing an explicit false, so the table only ever holds deviations from default.

**Fan-out — control plane → region.** `ControlPlaneFeatureFlagService.setFlag` writes
the override and a `feature_flags_sync` outbox event in one transaction (INV-7). The CP
outbox listener handles the event by re-reading the user's overrides _at delivery time_
and pushing the full resolved snapshot to the workspace's region via
`RegionalClient.syncUserFeatureFlags` → `POST /internal/feature-flags` (shared-secret
auth, same transport as the authz membership fan-out). Snapshot semantics make the call
idempotent and replay-safe: rapid toggles collapse to the latest state, and a retried
event can never resurrect stale values.

**Regional mirror and broadcast.** The internal endpoint resolves the WorkOS user to
the regional user row, then `FeatureFlagService.applySync` replaces the user's rows in
`user_feature_flags` (set-based delete + upsert, INV-20/INV-56) and writes a
`feature_flags:updated` outbox event in the same transaction. The event is user-scoped
(`targetUserId`), so the broadcast reaches exactly that user's socket rooms, carrying
the full resolved map.

**Read paths.** Backend code calls `featureFlagService.isEnabled(workspaceId, userId,
key)` (or `getFlags` for the whole map). The frontend receives `featureFlags` on
`WorkspaceBootstrap`, kept live by the socket handler in
`apps/frontend/src/sync/workspace-sync.ts` (same shape as `workspace_settings:updated`:
bootstrap-cache-only, no IDB table), and components read it through
`useFeatureFlag(workspaceId, "key")` — a cache-only observer that returns `false` until
the bootstrap lands, which is indistinguishable from the default.

That's the whole loop: backoffice toggle → CP outbox → regional snapshot → user-scoped
broadcast → bootstrap cache → hook re-render. If you only wanted the model, you can
stop here.

## Details worth knowing

- **Adding a flag** is one line in `FEATURE_FLAG_KEYS` plus the `isEnabled` /
  `useFeatureFlag` call sites. **Removing one** is deleting that line and those call
  sites; stale rows on both planes are filtered out at read time by
  `resolveFeatureFlags`.
- **Unknown keys are tolerated on the wire.** The regional internal endpoint accepts
  keys outside its registry (the control plane may deploy a new key ahead of the
  region) and stores them; they stay invisible until the region's registry catches up.
- **User not provisioned yet.** If a flag is set for someone who has never signed into
  the region, `applySync` logs a warning and skips (returns 204 so the CP outbox event
  isn't poisoned). The next toggle after the user exists re-syncs the full snapshot.
- **Offline sessions** converge through the normal bootstrap path: `featureFlags` rides
  `WorkspaceBootstrap`, and reconnect invalidation (INV-53) refetches it; the
  `feature_flags:updated` handler is also idempotent under sync-log catch-up replay
  (full-map replacement, no increments).
- **Verification surface.** The registry ships with one deliberately-temporary key,
  `demo-banner`, rendered by `FeatureFlagDemoBadge` (a fixed pill in the workspace
  shell) purely to prove the pipeline end to end. Delete both together once a real
  flag exists.

## Invariants

- **INV-4 / INV-7** — both planes pair the domain write with its outbox event in one
  transaction; delivery is never an ad-hoc publish.
- **INV-20 / INV-56** — override upserts are `ON CONFLICT` race-safe; the regional
  snapshot replace is two set-based statements, not per-row loops.

## Entry points

- `packages/types/src/feature-flags.ts` — the registry, `FeatureFlags` type,
  `resolveFeatureFlags`.
- `apps/control-plane/src/features/feature-flags/` — overrides table access, backoffice
  handlers, outbox fan-out.
- `apps/backend/src/features/feature-flags/` — regional mirror, internal sync endpoint,
  `isEnabled`.
- `apps/frontend/src/hooks/use-feature-flags.ts` — `useFeatureFlag`.
- `apps/backoffice/src/pages/workspace-detail-flags.tsx` — the admin toggle grid.
