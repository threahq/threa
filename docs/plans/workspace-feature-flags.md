# Feature flags: workspace scope + first-render delivery

Status: ratified 2026-07-20. Design: https://seer.build/ws_vbyzjvdg6g/b/ff-design-e04669/

Make `useFeatureFlag` mean the same thing whether a flag was set for a workspace,
for a user, or not at all — and make it correct on first render rather than second.

## Problem

Three distinct problems, one of which is the stated ask:

1. **Scope is baked into the primary key.** `feature_flag_overrides` (CP) and
   `user_feature_flags` (regional) are keyed `(workspace_id, user_id, flag_key)`.
   No row shape means "the whole workspace".
2. **A second flag system is the one in production.** `callsEnabled` lives in
   `workspace_setting_overrides`; its own doc comment (`packages/types/src/workspace-settings.ts:85`)
   calls it a feature flag. It went to settings because flags have no workspace tier.
3. **Flags aren't persisted client-side.** `applyWorkspaceBootstrap` writes 13 IDB
   tables, not `featureFlags`. The loading gate opens off IDB
   (`apps/frontend/src/contexts/coordinated-loading-context.tsx:212-217`), so warm
   starts paint fully while flags are still `undefined` and read as registry defaults.
   Default-off degrades politely; default-on paints wrong then flips.

**Timing.** `FEATURE_FLAGS = {}` today, so there are no _live_ flag values to migrate.
The tables are not empty in history — `board-view` and `sync-v2-cursor` were per-user
rollouts, and retiring a flag only drops the registry entry, never the rows — but any
surviving rows are overrides for keys no longer in the registry, hence inert (read paths
filter through the registry). The CP table ALTERs in place (rows re-keyed to
`subject_type='user'`); the regional table drops (its inert rows carry nothing forward and
the region re-syncs). So no live value migrates and no dual-read window is needed. This is
the cheapest this change will ever be.

## Ratified decisions

| #   | Decision                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Per-flag declared scopes, as a list: `["workspace"]`, `["user"]`, or both. A flag may legitimately need both — an in-development composer enabled for one whole workspace _and_ for named power users elsewhere. |
| 2   | Key regional user rows by `workos_user_id`, fixing the silent dropped-sync for users who haven't signed into the region yet.                                                                                     |
| 3   | Flag writes stay control-plane/backoffice only. Flags are **rollout only**. Entitlement gating ("is this workspace paying for it") is a different system with different inputs and is explicitly not this.       |
| 4   | `callsEnabled` migrates to a `calls` flag inside this stack, for dogfooding.                                                                                                                                     |

## Design

### Resolution

```
registry default  →  workspace override  →  user override
```

Layered only across the scopes a flag declares: a stored workspace row for a
`scopes: ["user"]` flag is inert, exactly as a row for a retired key is inert today.
One shared resolver runs on both sides of the stack.

### Registry

```ts
export const FEATURE_FLAGS = {
  calls: defineFlag({ values: ["off", "on"], scopes: ["workspace"], default: "on" }),
  newComposer: defineFlag({ values: ["off", "on"], scopes: ["workspace", "user"], default: "off" }),
} as const satisfies FeatureFlagRegistry
```

Default is an **explicit** field, not the first array element (ratified 2026-07-20 — implicit
first-value-wins was rejected as a hidden coupling). `defineFlag` enforces `default ∈ values`
at compile time. Deleting a key still retires a flag with no migration.

`calls` defaults `on`: enabled for every workspace, opt out via a workspace `off` override.
The env gate `cloudflareRealtime.enabled` still fronts it, so default-on only surfaces calls
where Cloudflare Realtime is actually configured (see PR 5).

### Storage (both planes, same shape)

```sql
workspace_id  TEXT NOT NULL,
subject_type  TEXT NOT NULL,   -- 'workspace' | 'user'  (TEXT + code validation, INV-3)
subject_id    TEXT NOT NULL,   -- workos_user_id, or workspace_id for workspace scope
flag_key      TEXT NOT NULL,
value         TEXT NOT NULL,
PRIMARY KEY (workspace_id, subject_type, subject_id, flag_key)
```

`subject_id` is non-null and carries the workspace id for workspace rows. A nullable
user column would let Postgres' NULLs-are-distinct rule permit duplicate workspace rows.

### Fan-out

The region stores both layers separately and resolves at read. The CP outbox payload
stays identity-only (`{workspaceId, subjectType, subjectId}`) so rapid changes still
collapse and replays stay idempotent; the handler re-reads at delivery and pushes that
subject's **raw overrides**, not a resolved map.

One workspace-scope change is one write and one broadcast regardless of member count
(a resolved per-user push would be one write per member — INV-56 — and would race
membership changes). New members inherit workspace flags with no sync at all.

### Delivery

Bootstrap carries raw layers; the client runs the same resolver:

```ts
featureFlags?: {
  workspace: Record<string, string>
  user:      Record<string, string>
}
```

Optional, per the house convention for post-v1 bootstrap fields (absent reads as all
defaults).

Two socket events, not one: `feature_flags:updated` (user-scoped, existing) keeps
carrying the user layer, and `feature_flags:workspace_updated` (workspace-scoped, new)
carries the workspace layer. The outbox routes by a static `USER_SCOPED_EVENTS` list
(`apps/backend/src/lib/outbox/repository.ts:1332`), so one event type cannot reach both a
user room and a workspace room. Two events also match the real audiences — the layers
have genuinely different recipients. Each patches its own layer client-side; the client
re-resolves.

Write and broadcast separate cleanly: the write always lands, the user-scoped
broadcast is best-effort (no regional user row means nobody is connected to receive it).
That is the decision-2 fix — today the _write_ is dropped, not just the broadcast.

### First render

Persist both layers in `applyWorkspaceBootstrap` alongside the other 13 tables and add
them to the gate's readiness check. The gate already blocks on IDB, so the
localStorage mirror sketched in `docs/features/architecture/feature-flags.md:100-105`
is a second persistence path for the same guarantee — not built.

Flags gate UI, never authorization. Anything enforceable resolves server-side through
`getFlag` (INV-11).

### Call sites — unchanged, and that is the point

```ts
useFeatureFlag(workspaceId, "calls") === "on"
await featureFlags.getFlag(workspaceId, userId, "calls")
```

Nothing at a call site knows which layer supplied the value.

## PR stack

Each PR must be independently green (typecheck + tests); intermediate states carry no
deprecated aliases (INV-49).

### PR 1 — types: scoped registry + layered resolver

- `packages/types/src/feature-flags.ts`: entries become `{ values, scopes }`;
  add `FeatureFlagScope`, `FeatureFlagLayers`, `flagAllowsScope`.
- `resolveFeatureFlags` takes `FeatureFlagLayers` and applies workspace-then-user,
  filtering by registry key, declared value, **and** declared scope. Single function,
  no alias retained.
- Update the two existing callers (CP service, regional service) to pass layers so the
  PR is green on its own.
- Tests: scope filtering, precedence, retired-key/value inertness.

### PR 2 — control plane: subject-keyed storage and writes

- Migration `012_*`: `ALTER TABLE feature_flag_overrides` add `subject_type`/`subject_id`,
  backfill from `workos_user_id`, swap PK, drop `workos_user_id`. ALTER rather than
  drop-and-recreate — safe whether or not the table is empty.
- Repository subject-keyed: `listByWorkspace`, `listForSubject`, `setOverride`, `deleteOverride`.
- `setFlag({workspaceId, scope, subjectId, flagKey, value})` — 400 when the flag does not
  declare that scope, alongside the existing unknown-key/value rejections.
- Outbox payload `{workspaceId, subjectType, subjectId}`; `syncToRegion` pushes raw overrides.
- Routes: GET returns both layers; PUT accepts a scope. Platform-admin only (decision 3).
- Backoffice `workspace-detail-flags.tsx`: a workspace-scope row above the member grid,
  with per-flag controls disabled for scopes the flag does not declare.

### PR 3 — regional: subject-keyed mirror, layered bootstrap, scope-routed broadcast

- Migration: new subject-keyed table; drop `user_feature_flags` (provably empty).
  User rows keyed by `workos_user_id` (decision 2).
- `applySync` replaces one subject's rows and no longer resolves a regional user first,
  so the write never drops; the user-scoped broadcast is best-effort.
- Service: `getFlagLayers(workspaceId, workosUserId)`, plus `getFlags`/`getFlag` preserved
  for backend callers.
- Outbox: add `feature_flags:workspace_updated` (workspace-scoped) alongside the existing
  user-scoped event.
- `WorkspaceBootstrap.featureFlags` becomes optional `FeatureFlagLayers`; bootstrap handler
  emits layers.

**Boundary note:** the bootstrap type change breaks the frontend hook's typecheck, so this
PR also carries the minimal frontend work needed to stay green on its own — the hook
resolving layers, and the two socket handlers patching their layer. Persistence and the
gate are PR 4. Splitting it the other way would leave PR 3 red.

### PR 4 — frontend: persistence and first-render correctness

- Persist layers in `applyWorkspaceBootstrap`; add to the coordinated-loading readiness
  check (`apps/frontend/src/contexts/coordinated-loading-context.tsx:212-217`).
- `feature-flags-tab.tsx` shows provenance (workspace vs user) now that layers survive.
- Tests: warm start renders the persisted value rather than the registry default —
  including a **default-on** flag whose workspace override is off, which is the case that
  fails loudest today.

**Known residual:** a flag added after a client's last bootstrap has no key in the
persisted layers and falls to its registry default for one warm start. Bounded to the
first load after a flag ships; unavoidable without blocking paint on the network.

### PR 5 — calls: `callsEnabled` → `calls` flag

- Registry: `calls: { values: ["off", "on"], scopes: ["workspace"] }`.
- Backend `features/calls/handlers.ts:105-112` and `signaling-gateway.ts:114-119` read
  through `getFlag`. Keep the env gate `config.cloudflareRealtime.enabled` — that is
  deployment capability, not rollout.
- Frontend `pages/stream.tsx:228` and `user-profile-modal.tsx:118` read `useFeatureFlag`.
- Delete `callsEnabled` from the settings interface, defaults, update input, zod schema,
  and `flattenUpdates`' `simpleKeys`.
- Migration deleting stale `workspace_setting_overrides` rows with `key = 'callsEnabled'`.
- Update `tests/browser/calls.spec.ts` and `apps/backend/scripts/calls-spike/harness.ts`,
  which currently flip the setting via raw PATCH.

**Ops precondition for PR 5:** confirm via read-only prod query that no workspace has
`callsEnabled = true`. Flags live in the control-plane DB and settings in regional DBs,
so no migration can carry a live value across; any enabled workspace must be re-enabled
by hand in the backoffice.

## Known boundary — no per-user opt-out below a workspace override

Storage keeps only deviations from a flag's default (`setFlag` deletes the override when
the chosen value equals `defaultFeatureFlagValue`). So for a both-scoped flag whose
workspace override differs from the default, an individual user cannot be pinned back to
a value that equals the default — selecting it clears the override and the user re-inherits
the workspace value. The enable direction (user on, over a default-off / workspace-silent
flag) is unaffected, which is the motivating use case. Nothing in this stack is both-scoped
(`calls` is workspace-only), so this is latent. Lifting it means an explicit inherit/reset
action that stores every concrete override rather than clearing on default — a stack-wide
semantics change, deferred until a both-scoped flag needs per-user opt-out.

## Not building

- localStorage mirror for flags (IDB + the existing gate covers it).
- Entitlement/plan gating, per decision 3.
- Percentage rollouts, cohorts, environment targeting.
- Merging workspace settings and feature flags into one system. The boundary is:
  flags are temporary, platform-owned rollout dials; settings are permanent,
  admin-owned product configuration. `calls` returns to settings at GA.
- Any in-app (regional) write path for flags.

## Review

After the last chunk: whole-stack adversarial review by Fable and, concurrently,
GPT-5.6 Sol at xhigh effort via Pi.
