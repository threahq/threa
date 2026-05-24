# Threa - AI-Powered Knowledge Chat

## What This Is

Threa tackles "Slack, where critical information comes to die" by building knowledge foundations with language models. The core differentiator is GAM (General Agentic Memory): automatically extracting and preserving knowledge from conversations.

**Solo-first philosophy:** Threa starts as AI-powered personal knowledge management and grows into team chat. Scratchpads are the primary entry point, not channels.

## How To Use This Document

This file is the project source of truth for architecture and code constraints.

When rules compete, use this precedence order:

1. **Correctness and safety first** (data integrity, concurrency, transaction safety)
2. **Architecture boundaries second** (feature placement, layering, dependency flow)
3. **Task scope third** (smallest working change that solves the request)
4. **Style and ergonomics last** (cleanup, formatting, readability polish)

Default implementation mode for routine tasks: **minimal patch**. Do not refactor, rename, or generalize unless it is required to satisfy a higher-priority rule above.

## Working Style

Read this before asking the user anything.

**Search before you ask.** If a question has a factual answer in the repo ("is there a sync path from control-plane to backend?", "which model does persona X use?", "how does auth flow through the workspace-router?"), it is your job to find it. Use Grep, Glob, and the Agent tool. Start from `docs/system-overview.md`, `docs/architecture.md`, `docs/core-concepts.md`, then `apps/*/src/` and the relevant feature folder under `apps/backend/src/features/`. Escalate to the user only when (a) the search genuinely came back empty, (b) the decision is a preference the code cannot reveal, or (c) the action is destructive or irreversible.

**Sweep before concluding absent.** Before claiming a UI or feature is missing, sweep `apps/*/src/{components,pages,features,stores,lib}/` with contains-match globs (`*settings*`, not `settings*` — the latter misses `workspace-settings`). A wrong negative compounded by confidence is worse than asking.

**Prove you looked.** When you do ask, name what you already searched — file paths, grep patterns, docs read — so the user can redirect you instead of repeating the search. An unjustified clarifying question is worse than silence.

**Follow instructions verbatim.** When CLAUDE.md, a skill, or the user says "always use X", "never do Y", or "use the /foo skill for Z", that is a binding constraint, not a suggestion. Re-read the relevant rule before acting in its domain — especially invariants (INV-*), the Greptile rule, and skill invocation rules.

**Read before editing.** Before changing a module, read it and its neighbors. Backend features colocate (INV-51) — handler, service, repo, worker, config, tests all sit in the same folder, so the answer is usually one directory away.

**Understand intent, don't pattern-match.** Two similar lines aren't a pattern; the invariant is. INV-20 is not "sprinkle `ON CONFLICT`", it is "write paths tolerate concurrent callers". Apply the rule that fits the situation, not the shape that looks familiar.

**Worked example — the failure mode this replaces.** User asks: "Is there a sync path from control-plane to backend?" Wrong response: ask the user to confirm. Right response: grep `control-plane`, open `docs/system-overview.md`, discover the `provisionRegional` outbox event calling `POST /internal/workspaces` on the regional backend (lines 218-219, 274), answer with the citation. Do this every time before reaching for a clarifying question.

## Runtime and Build

Default to Bun instead of Node.js:

- `bun <file>` instead of `node <file>` or `ts-node <file>`
- `bun run test` instead of `jest` or `vitest`
- `bun build <file>` instead of `webpack` or `esbuild`
- `bun install` instead of `npm install`
- `bun run <script>` instead of `npm run <script>`
- Bun auto-loads `.env` - do not use `dotenv`

## Workflow and Verification

Prefer test-first development: write or update a failing test that captures the desired behavior, then implement the fix.

For small bug fixes where a reproducible test is not practical, at minimum run the most relevant existing test suite and verify behavior manually.

Never ship unexecuted tests. Run:

- `bun run test:e2e` for E2E coverage
- `bun run test` for unit/integration coverage

### Greptile Reviews

When asked to check Greptile comments, review feedback, confidence score, or anything Greptile-related, **always use the `/review-greptile` skill**. Never manually call the fetch script or GitHub API for Greptile data — the skill handles fetching, staleness detection, triage, and thread responses.

If tests fail, fix them or explicitly isolate the failure in a separate follow-up change.

## Project Structure

Monorepo with Bun workspaces:

```text
threa/
|- apps/
|  |- backend/          # Regional Express API + Socket.io + workers
|  |- frontend/         # React 19 + Vite + Shadcn UI
|  |- control-plane/    # Global auth, workspace creation, region assignment
|  `- workspace-router/ # Cloudflare Worker edge router
|- packages/
|  |- types/            # Shared domain types and API contracts
|  |- prosemirror/      # Editor state wrapper
|  `- backend-common/   # Shared backend infra (DB, auth, outbox, middleware)
|- infra/aws/           # Terraform for per-region S3 buckets
|- scripts/             # Dev orchestration and utilities
|- tests/               # Cross-app tests (Playwright)
|- docs/                # Design docs and exploration notes
|- .agents/skills/      # Shared agent skills (Claude + Codex)
`- package.json         # Root workspace config
```

For a high-level view of how the four services interact, their responsibilities, infrastructure dependencies, and deployment targets, see [`docs/system-overview.md`](docs/system-overview.md).

Agent skills live in `.agents/skills/<name>/SKILL.md`. `.claude/skills` is a symlink to `.agents/skills/`.

### Backend Feature Colocation

Backend domain logic lives in `apps/backend/src/features/<name>/` (INV-51). Each feature colocates handler, service, repository, outbox handler, worker, config, and tests.

`lib/` is for cross-cutting infrastructure only (queueing, outbox dispatch, AI wrapper, utilities, logging). Domain-specific prompt builders, classifiers, extractors, and event handlers stay in feature folders.

Feature public APIs are exported via `index.ts` barrels; other features import from barrels only (INV-52).

## Invariant Playbook (Narrative)

Use invariant IDs in planning, review notes, and PR comments. The rules below are grouped by intent, with concrete examples.

### 1) Data Model and Persistence Safety

Relational integrity is enforced in application code, not in PostgreSQL schema design:

- No foreign keys (INV-1)
- No DB enums; use `TEXT` and validate in code (INV-3)
- All entities use prefixed ULIDs like `stream_xxx` (INV-2)
- Workspace is the data ownership and sharding boundary (INV-8)
- All product/domain data persisted in PostgreSQL must be workspace-scoped via `workspace_id`
  and must be queried/mutated with a workspace filter. Global-only infra/auth tables are the
  explicit exception (e.g. auth sessions, queue internals, outbox listeners, migration metadata).
- Use `UserId` for workspace-scoped identity.
  `MemberId` is reserved for stream membership surfaces (`stream_members` and stream member APIs/events) (INV-50)

Migrations are append-only (INV-17). Never edit existing migration files.

Write paths must be race-safe:

- Never do select-then-update without locking/concurrency control (INV-20)
- Prefer set-based/batch DB operations over per-row loops (INV-56)
- Avoid `withClient` for single-query paths; pass `pool` directly (INV-30)
- Do not keep DB connections open during slow AI/network work (INV-41)
- Do not store transient workflow state on core domain entities; use tracking tables (INV-57)

Example: race-safe upsert instead of check-then-act.

```sql
-- Preferred (INV-20)
INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (workspace_id, workos_user_id)
DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name;
```

```sql
-- Avoid (INV-20)
SELECT id FROM users WHERE workspace_id = $1 AND workos_user_id = $2;
-- then conditionally INSERT or UPDATE in app code
```

### 2) Architecture Boundaries and Dependency Flow

Real-time delivery goes through the outbox pattern, not ad hoc publish calls (INV-4). Event-source updates and read projections are committed together (INV-7).

Services own transactions (INV-6). Handlers and workers stay thin and infrastructure-focused (INV-34), delegating business logic to services and domain modules.

Repository pattern expectations:

- Data access goes through repositories (INV-5)
- Prefer composable generic repo methods over one-off method sprawl (INV-27)

Dependency rules are strict:

- No hidden singletons (except approved logger, Langfuse/OTEL, and web-push bootstrap constraints) (INV-9)
- Dependency names must describe what they are (INV-10)
- Fail loudly; no silent fallback defaults (INV-11)
- Pass constructed dependencies, not raw config values (INV-12)
- Construct long-lived collaborators once; avoid per-call dependency assembly (INV-13)
- Reuse existing helpers and abstractions instead of parallel implementations (INV-35, INV-37)

Example: construct once, then call with params.

```ts
// Preferred (INV-12, INV-13)
const conversationService = new ConversationService({ pool, outboxPublisher })
await conversationService.createMessage({ streamId, content })
```

```ts
// Avoid (INV-12, INV-13)
await createMessage(
  { connectionString, redisUrl, apiKey },
  { streamId, content }
)
```

### 3) API Contracts, Validation, and Types

Inputs (`body`, `query`, `params`) are validated with Zod schemas, not manual `typeof` checks (INV-55).

Errors carry explicit HTTP semantics via `HttpError` classes (`status`, `code`) and are formatted by middleware (INV-32).

Type derivation should flow from schemas/constants to inferred types to avoid drift (INV-31).

Avoid hardcoded display text in backend responses; return structured data and format in frontend (INV-46).

Avoid magic strings by centralizing constants at the source of truth (INV-33).

`contentJson` (ProseMirror JSONContent) is the canonical internal representation for message content. Markdown is a serialization format for external callers (API wire format). Internal code (components, stores, optimistic events, IDB) should always pass and store `contentJson`; only serialize to markdown at the system boundary when sending to the API (INV-58).

### 4) AI Integration and Language Behavior

Use only current-generation models listed in `docs/model-reference.md` (INV-16). All AI usage goes through the project AI wrapper (`createAI`), not raw SDK imports (INV-28).

Every AI wrapper call must include telemetry metadata (INV-19).

AI component config lives next to the component in `config.ts` and is shared by production and evals (INV-44). Evals call production entry points rather than reimplementing logic (INV-45).

Do not make semantic decisions with language-specific heuristics or English-only literals/regexes; use model-based decisions for language-dependent behavior (INV-54).

### 5) Frontend Composition and UX Semantics

Use Shadcn UI components from `apps/frontend/src/components/ui/` for primitives (INV-14). React components should stay UI-focused and avoid business logic or persistence access (INV-15).

Do not define components inside other components (INV-18).

Hints/tooltips/popovers must not cause layout shift (INV-21).

Navigation uses links; actions use buttons (INV-40):

```tsx
// Preferred (INV-40)
<Link to={streamUrl}>Open stream</Link>
<button onClick={archiveStream}>Archive</button>
```

```tsx
// Avoid (INV-40)
<button onClick={() => navigate(streamUrl)}>Open stream</button>
```

Socket subscriptions must always pair with bootstrap fetches, and bootstrap must be invalidated on reconnect/resubscribe to close event gaps (INV-53).

User-facing dates render in the device's local time (INV-42). Use the helpers in `apps/frontend/src/lib/dates.ts` (`formatDate`, `formatTime`, `formatRelative`, `formatFull`) — they fall through to the browser's locale and timezone, which is what users expect to see in the UI. The `prefs?: TimePrefs` argument these helpers accept is for non-UI contexts (background jobs, server-side prompt rendering, scheduled notifications) where there is no device — in those contexts `prefs.timezone` is the source of truth. Do not force `prefs.timezone` into UI surfaces; it overrides what the user's actual device shows and creates drift across the app.

Multi-view pages (tabs, sub-sections, filter states) must derive their active view from the URL, not from `useState` — a refresh, back/forward, or shared link must land the user on the same view they were looking at (INV-59). Use distinct route segments like `/saved`, `/saved/done`, `/saved/archived` rather than a query string when there's a small fixed set of views so the URLs read naturally. Tab onChange handlers should `navigate(...)` to the new segment; the view hook reads `useParams()` (or a route-level loader) and falls through to a sensible default for the unsegmented path.

Preview surfaces must strip markdown before rendering. Any UI that shows a preview of user-authored message content (thread cards, sidebar stream previews, activity feed snippets, notification text, quoted snippets, search results) must route `contentMarkdown` through `stripMarkdownToInline()` in `apps/frontend/src/lib/markdown/strip.ts` or `truncateContent()` in `apps/frontend/src/components/layout/sidebar/utils.ts` — never pass raw markdown into a plain `<span>`, or literal syntax (`**bold**`, fenced code, `[text](url)`, `:emoji:` shortcodes) ships to users as characters (INV-60). Backend sends raw markdown on the wire; frontend strips at render time. Reference surfaces that already do this correctly: `StreamItemPreview` (sidebar stream list) and `ActivityPreview` (activity feed).

### 6) Testing and Reliability Expectations

Always resolve failing tests; do not dismiss failures as pre-existing (INV-22).

Tests should verify behavior, not brittle internals:

- Do not assert event counts; assert presence/content of specific events (INV-23)
- Prefer one object comparison over chains of narrow assertions (INV-24)
- No `.skip()` or `.todo()` tests (INV-26)
- Avoid `mock.module()` and `vi.mock()` for shared modules; prefer scoped `spyOn` patterns against namespace imports (INV-48)

Frontend integration tests should mount real components and exercise observable user behavior (INV-39).

### 7) Maintainability and Scope Control

Do not add speculative features, configuration, or comments for imagined requirements (INV-36).

Delete dead code immediately (INV-38). Do not carry deprecated aliases after renames (INV-49).

Comments explain why the current implementation works; they do not narrate the change history (INV-25).

Avoid nested ternaries beyond one level (INV-47).

When handling variants, colocate variant config and keep shared behavior on one path (INV-29, INV-43).

## Quick Invariant Lookup

- **Persistence and data integrity:** INV-1, INV-2, INV-3, INV-8, INV-17, INV-20, INV-30, INV-41, INV-50, INV-56, INV-57
- **Architecture and dependencies:** INV-4, INV-5, INV-6, INV-7, INV-9, INV-10, INV-11, INV-12, INV-13, INV-27, INV-34, INV-35, INV-37, INV-51, INV-52
- **API and backend contracts:** INV-31, INV-32, INV-33, INV-46, INV-55, INV-58
- **AI and eval discipline:** INV-16, INV-19, INV-28, INV-44, INV-45, INV-54
- **Frontend and UX behavior:** INV-14, INV-15, INV-18, INV-21, INV-40, INV-42, INV-53, INV-59, INV-60
- **Testing:** INV-22, INV-23, INV-24, INV-26, INV-39, INV-48
- **Code hygiene and maneuverability:** INV-25, INV-29, INV-36, INV-38, INV-43, INV-47, INV-49

When introducing a new invariant:

1. Document it in this file with the next available ID.
2. Add tests that enforce it.
3. Reference it in nearby code comments if the constraint is non-obvious.

## Backend Architecture Quick Reference

Three-layer model:

- **Handlers**: validate input, check auth, delegate to services, format responses
- **Services**: orchestrate business logic and transaction boundaries
- **Repositories**: pure data access, first arg is a `Querier` (`Pool` or `PoolClient`), map snake_case <-> camelCase

Common patterns:

- Factory pattern for handlers/middleware dependency injection
- Single query: pass `pool`; multiple related reads: `withClient`; multi-operation writes: `withTransaction`
- Two pools: main (30 conns) and listen (12 conns) to avoid LISTEN starving transactional work
- Handlers throw `HttpError`; error middleware handles response formatting
- Outbox events are written in the same transaction as domain writes; dispatcher publishes asynchronously

See `docs/backend/` for deeper guides.

## Frontend Patterns

Cache-only observer pattern for TanStack Query v5: provide a `queryFn` that reads from cache. `enabled: false` alone is not enough.

```tsx
const { data } = useQuery({
  queryKey: someKeys.bootstrap(id),
  queryFn: () => queryClient.getQueryData<SomeType>(someKeys.bootstrap(id)) ?? null,
  enabled: false,
  staleTime: Infinity,
})
```

Do not call `queryClient.getQueryData()` directly in render for reactive reads.

`WorkspaceBootstrap.streams` is `StreamWithPreview[]`, not `Stream[]`. When adding streams to sidebar cache, spread with `{ ...stream, lastMessagePreview: null }`.
