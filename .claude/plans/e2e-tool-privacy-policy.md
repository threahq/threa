# Per-stream tool-privacy policy (foundation slice)

## Why

Ariadne running in an E2E scratchpad can reach external services (web search,
URL reads, the web-only research loop). For a privacy-sensitive scratchpad the
owner may want to dial that down — "no tools at all", "web but nothing else",
later "workspace reads but no web". We want to be **honest but configurable**
about the privacy a given scratchpad gives up.

Today tool access is gated only at the **persona** level (`enabledTools`), which
is global to the persona, not per-stream. There is no per-stream or
per-workspace knob, and the enclave builds its own tool set
(`buildEnclaveTools`) from the session assignment — so any per-stream policy
must be carried **in the assignment** and enforced inside the enclave, not just
in the backend's `buildToolSet`.

## Scope of THIS slice (the enforcement spine only)

The control surface (HTTP + UI to set a policy) and the workspace-level default
are deliberately **later slices**. This slice lands the mechanism and proves it
with unit tests, defaulting to today's behavior (no restriction) so it's a pure
no-op until a policy is actually set.

- **Categories, not raw tool lists.** A coarse privacy category per tool
  (`web` / `workspace` / `github` / `linear`, plus always-allowed `messaging`).
  The owner picks categories, not a 33-tool checkbox.
- **Per-stream storage on `e2e_streams`** (`allowed_tool_categories TEXT[]`,
  NULL = no restriction). The dispatch worker already loads this row.
- **Carried in `EnclaveSessionAssignment`** (`allowedToolCategories?`), omitted
  when NULL.
- **Enforced in `buildEnclaveTools`**: the enclave only has web tools today, so
  in practice the gate is "web allowed?" — if not, the enclave runs with no web
  tools and no research (pure model + `send_message`). `send_message` is never a
  privacy category; the agent must always be able to reply.

## As-built

### `packages/types` (shared source of truth, INV-33)
- New module `tool-privacy.ts`:
  - `TOOL_PRIVACY_CATEGORIES` / `ToolPrivacyCategory` / `ToolPrivacyCategories`
  - `TOOL_CATEGORY_BY_NAME: Record<AgentToolName, ToolPrivacyCategory>` —
    exhaustive via `satisfies`, so a new tool fails to compile until categorized.
  - `isToolCategoryAllowed(allowed, category)` — `null/undefined` ⇒ all allowed;
    `messaging` is always allowed regardless of the list.
  - `isToolAllowedByPolicy(allowed, toolName)` — convenience over the map.
- `tool-privacy.test.ts` (`bun:test`): every tool name maps to a valid category;
  helper semantics (null = all, `[]` = messaging-only, explicit subset).
- `EnclaveSessionAssignment.allowedToolCategories?: ToolPrivacyCategory[]`.

### `apps/backend`
- Migration `…_e2e_stream_tool_policy.sql`: `ALTER TABLE e2e_streams ADD COLUMN
  allowed_tool_categories TEXT[]` (INV-17 append-only, INV-3 TEXT[] not enum).
- `E2eStreamsRepository`: read the column into `E2eStream.allowedToolCategories`
  (`null` when unset). No writer in this slice (control surface is next).
- `buildEnclaveSessionAssignment`: when `e2e.allowedToolCategories` is non-null,
  copy it onto the assignment; otherwise omit (back-compat = unrestricted).

### `apps/enclave`
- `EnclaveToolDeps.allowedCategories?`; `buildEnclaveTools` returns `[]` when
  `web` is not allowed (no web_search, no read_url, no general_research).
- `run-turn` passes `request.allowedToolCategories` straight through.

## Tests
- `request-builder.test.ts`: policy present ⇒ assignment carries it; null ⇒
  omitted.
- enclave `tools.test.ts`: `["web"]`/undefined ⇒ web tools; `[]`/`["workspace"]`
  ⇒ no tools.
- `tool-privacy.test.ts`: map exhaustiveness + helper semantics.

## Follow-up slices (NOT here)
1. **Control surface**: `E2eStreamsRepository.setToolPolicy` + PATCH endpoint +
   Zod validation + a privacy-tier picker in the scratchpad UI.
2. **Workspace default**: a workspace-level default policy streams inherit when
   their own is NULL.
3. **Backend-persona adoption**: intersect the same category policy in
   `buildToolSet` for non-E2E streams (needs a general per-stream policy store,
   since non-E2E streams have no `e2e_streams` row).
4. **Workspace search via S2**: once the UIK-signed capability lands, the
   `workspace` category gates it here.
