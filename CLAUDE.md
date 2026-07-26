# Threa — AI-Powered Knowledge Chat

Threa fixes "Slack, where critical information comes to die": GAM (General Agentic Memory) auto-extracts and preserves knowledge from conversations. Solo-first — scratchpads are the entry point, not channels.

This file is the source of truth for architecture and code constraints. When rules compete:

1. Correctness and safety (data integrity, concurrency, transactions)
2. Architecture boundaries
3. Task scope — smallest working change
4. Style and polish

Default mode: **minimal patch** — the smallest change that still fully solves the problem, not a half-fix. Order of work: get it working → get it nice → get it fast. Once it works, step back once — smaller? clearer? — then stop. No refactors, renames, or generalization unless a higher rule demands it.

## Output Style

Extremely terse. Fragments fine; drop articles, transitions, hedging, polish. Every line adds a decision-, action-, risk-, or verification-relevant fact. State each fact once. Lead with the result; no closing recap.

- **Status replies:** result first; then only material changes, verification, risk/blocker, next action. Max 6 lines unless the user requests a report. No headings when one list works. Never invent a risk or next step.
- **Every chat/channel/scratchpad message IS a status reply** — including final answers and "done" messages. "Report" exists only when explicitly requested; a finished task is not a request for one. Detail belongs in the PR description or review comment — link it, never restate it in chat. Recurring violation: bold-header "What shipped" essays after a task completes. Don't.
- **PR descriptions:** why, material changes/decisions, verification, residual risk. Target 150–300 words; exceed only for facts needed to review safely. No file inventory. Collapse tests/reviews into one verification line unless a failure or caveat needs detail.
- **Format:** short bullets or 1–2-sentence paragraphs. Combine related facts with semicolons. Choose summary or detail list—never both. References inline (`path`, symbol, PR). No bold-header mini-essays.
- **Copy tasks:** when the task's deliverable creates, revises, or audits user-facing product, marketing, documentation, UI, or PR copy, apply the `deslopify` skill. Preserve the writer's voice; remove rhetorical templates, hype, vague importance claims, decorative formatting, and robotic symmetry. Never infer AI authorship from style patterns. Status replies still follow the limits above.
- **Cut:** preamble, request restatement, investigation chronology, self-narration, editorializing ("honest answer", "worth noting", "genuinely"), repeated conclusions, user-decision echoes. Mention unchanged/out-of-scope work only when it defines the boundary or prevents a reviewer mistake.

Comments: default none (INV-25). A comment earns its place only by stating what the code cannot — an ordering/concurrency constraint, a load-bearing "looks wrong but isn't", why a bound is that value — and only if still true six months from now. Comments never dwarf the code: a long explanation of a 2-line fix belongs in the PR description, not the file. Delete on sight: change narration, restatement, section headers, speculative TODOs (INV-36).

## Search Before Asking

Factual repo questions are yours to answer: Grep/Glob/Agent, starting from `docs/system-overview.md`, `docs/architecture.md`, `docs/core-concepts.md`, then `apps/*/src/` and the relevant feature folder. Before claiming something absent, sweep `apps/*/src/{components,pages,features,stores,lib}` with contains-match globs (`*settings*`, not `settings*`). Ask only when the search came back empty, it's a preference code can't reveal, or the action is destructive — and name what you searched.

"Always X" / "never Y" rules (INV-*, skill rules) are binding — re-read them before acting in their domain. Read a module and its neighbors before editing; features colocate (INV-51), so the answer is usually one directory away. Apply an invariant's intent, not its surface shape: INV-20 means "write paths tolerate concurrent callers", not "sprinkle ON CONFLICT".

**Naming a skill is an instruction to load it.** When this file, the user, or another skill names one, invoke it before the first command in its domain — a summary here or a note in your own memory is a pointer, never the contract, and both go stale as skills gain tooling. A skill routinely ships a script or step its summary omits, so "the summary looked complete" is exactly how the omission stays invisible. If you concluded a capability doesn't exist without reading the skill that owns it, you concluded it from the wrong source; a skill's own fallback rules also override whatever workaround you devised.

## Runtime

Bun, not Node: `bun <file>`, `bun run test`, `bun install`, `bun run <script>`, `bun build`. Bun auto-loads `.env` — no dotenv.

## Previewing HTML — Seer

Anthropic artifacts don't render for this user; publish on Seer instead. Use it liberally — plans, diagrams, mockups, dashboards, reports — a URL beats a wall of HTML/ASCII. Full contract: https://seer.build/skill.md. Auth: `SEER_API_KEY` (already set; never print it).

- Bundle: build in `mktemp -d`, `index.html` at root, relative self-contained assets; `(cd "$dir" && zip -r bundle.zip . -x bundle.zip)`; `curl -X PUT --data-binary @bundle.zip -H "Authorization: Bearer $SEER_API_KEY" https://seer.build/api/bundles/<slug>`. Unique slug (`plan-$(openssl rand -hex 3)`); re-PUT same slug = new version, same URL. Share the response's `url`.
- Image (screenshots into PR/issue bodies): `PUT https://seer.build/api/images/shot.png` — response's `markdown` pastes into GitHub and renders even on private repos.

## Workflow

Test-first when practical; else run the nearest suite and verify manually. Never ship unexecuted tests: `bun run test`, `bun run test:e2e`. Failing tests get fixed, never dismissed as pre-existing (INV-22).

**Stacked PRs: always `gh stack`** (GitHub-native Stacks; extension installed — verify `gh extension list | grep stack`, never assume absence). Hand-rolling stacks with plain branches + `gh pr create --base` is the recurring failure — don't.

**Invoke the `/gh-stack` skill before your first stack command, every session.** The bullets below are a memory jog, NOT the contract — the skill carries operations they do not mention, `merge-stack.ts` chief among them. Anyone who works from this list alone reaches a wrong conclusion and acts on it; that has now happened more than once, always the same way: the summary feels complete, the tool that solves the problem is never discovered, and a forbidden fallback gets used instead. Repo memory is not a substitute either — it goes stale as the skill gains tooling. If you have already formed a plan for a stack without opening the skill, that plan is unvalidated.

- Once: `git config rerere.enabled true` and `git config remote.pushDefault origin`
- `gh stack init <branches bottom→top>` (adopts existing branches) · `gh stack add <branch>` per layer · `gh stack submit --auto` (recognizes `/create-pr`-made PRs and links them into the Stack)
- **`submit` is mandatory, not optional.** `/create-pr` (or `gh pr create --base <parent>`) opens the PRs but does NOT make a Stack — running `init`/`add` then skipping `submit` leaves unlinked, chained-base PRs. Finish every stack with `gh stack submit --auto` and confirm `gh stack view --json` shows a `Stack #NNNN`. Already have unlinked PRs? `gh stack submit --auto --open` retrofits the linkage in place.
- **Merging a Stack: `bun .agents/skills/gh-stack/scripts/merge-stack.ts <top-pr> --yes`** (`--dry-run` first to validate). Lands the whole stack server-side in one operation. `gh pr merge` on a linked Stack is REFUSED by GitHub ("must be merged sequentially using the stack merge API"), `gh stack` has no merge command, and the documented REST API has no merge route — none of that means there is no way to merge, and probing for one is wasted effort. If the wrapper fails, **stop and report**; do NOT `gh stack unstack` and merge per layer. Unstacking deletes base branches on merge, which auto-CLOSES every PR above (GitHub then refuses both reopen and base change, so each must be recreated).
- After merges: `gh stack sync --prune` — auto-recovers squash-merges; replaces manual rebase-on-main
- Non-interactive always: branch names as args, `submit --auto`, `view --json`

CodeRabbit reviews every PR (`.coderabbit.yaml`, derived from these invariants) — treat its findings like human review. Addressing review comments → always the `/respond-to-pr-review` skill. Unit of work complete (committed, pushed, verified) → open a PR via `/create-pr`, unless told not to, work is mid-stream, or a PR exists (push to it).

## Project Structure

Monorepo, Bun workspaces:

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
|- scripts/             # Dev orchestration
|- tests/               # Cross-app tests (Playwright)
|- docs/                # Design docs
`- .agents/skills/      # Shared agent skills (.claude/skills symlinks here)
```

Service interactions, responsibilities, deploy targets: `docs/system-overview.md`.

Backend domain logic: `apps/backend/src/features/<name>/` — handler, service, repo, outbox handler, worker, config, tests colocated (INV-51). `lib/` = cross-cutting infra only (queueing, outbox dispatch, AI wrapper, logging); domain prompt builders/classifiers/extractors stay in their feature. Cross-feature imports via `index.ts` barrels only (INV-52).

## Invariants

Use INV ids in plans, review notes, PR comments.

### Data & Persistence

- No foreign keys (INV-1). No DB enums — `TEXT` + code validation (INV-3). Prefixed ULIDs like `stream_xxx` (INV-2). Migrations append-only — never edit an existing file (INV-17).
- Workspace is the ownership/sharding boundary (INV-8): every domain table carries `workspace_id`, every query/mutation filters on it. Exempt only global infra/auth tables (auth sessions, queue internals, outbox listeners, migration metadata).
- `UserId` for workspace-scoped identity; `MemberId` only for stream-membership surfaces (`stream_members`, stream member APIs/events) (INV-50).
- Stream access is inherited, never direct (INV-62): threads carry no access of their own — resolve through `root_stream_id` to the nearest non-thread ancestor; public roots grant read without a `stream_members` row. Any access-gated query (search, feeds, sync catch-up, attachments, notifications) reuses `checkStreamAccess`/`listAccessibleStreamIds` (`apps/backend/src/features/streams/access.ts`) or replicates the thread→root rule, plus a test for the non-member-thread-inside-a-member-channel case. Filtering on raw `stream_members` is the recurring footgun — it silently drops thread content (membership ≠ access). Membership ≠ access ≠ read state: the per-user read watermark lives solely in `stream_read_state` (keyed by stream+user), never on `stream_members` — `stream_members` is participation only. Upserting read state is always safe once access is validated (it can't manufacture a member, so access-without-membership viewers get a real frontier); upserting membership on a read is forbidden.

Race-safe writes:

- No select-then-update without locking (INV-20); prefer upsert:

  ```sql
  INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (workspace_id, workos_user_id)
  DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name;
  ```

- A check-then-act guard pins the identity/generation observed at read (row id, version, external key) — never just a status flag; status-only guards let stale work clobber a replaced row (INV-20).
- Set-based/batch ops over per-row loops (INV-56). Single query → pass `pool`, not `withClient` (INV-30). Never hold a DB connection across slow AI/network work (INV-41). Transient workflow state in tracking tables, not domain entities (INV-57).
- Optimistic concurrency = integer version columns, never timestamp equality (INV-66). PG stores µs, JS `Date` round-trips ms — `WHERE fetched_at = $expected` is false on virtually every write once it crosses the driver, so the path "works never" while looking tested. CAS on an `INTEGER` version incremented every write (`scheduled_messages.version`, `link_previews.refresh_version` are the references). Tests of any timestamp/version-gated predicate must produce the value through the repo's own `NOW()` path and read it back through the repo — hand-crafted `.000Z` fixtures mask exactly this bug.
- Backfills activate via migration, deploy-safely (INV-67). A registered backfill definition is inert until enqueued — new-code tests all pass while old rows never flow through. Each backfill ships an enqueue migration (precedent: `20260621120000_backfill_mention_actor_refs.sql`) with `process_after = NOW() + ≥10 min`, so old-code replicas cut over before jobs run (`check:migrations` enforces the delay; premature claims throw `Unknown backfill` into the DLQ).

### Architecture & Dependencies

- Real-time delivery via the outbox pattern, never ad hoc publishes (INV-4). Outbox events written in the same transaction as domain writes; dispatcher publishes async. Event-source updates and read projections commit together (INV-7).
- Services own transactions (INV-6). Handlers/workers thin, infrastructure-only (INV-34). Data access through repositories (INV-5); composable generic repo methods over one-off sprawl (INV-27).
- No hidden singletons (exceptions: logger, Langfuse/OTEL, web-push bootstrap) (INV-9). Dependency names describe what they are (INV-10). Fail loudly, no silent fallbacks (INV-11). Pass constructed dependencies, not raw config (INV-12); construct long-lived collaborators once (INV-13) — `new ConversationService({ pool, outboxPublisher })` then call with params, never per-call assembly from connection strings. Reuse existing helpers over parallel implementations (INV-35, INV-37).

### API Contracts & Types

- Validate `body`/`query`/`params` with Zod, not manual `typeof` (INV-55). Errors via `HttpError` classes (`status`, `code`), formatted by middleware (INV-32). Derive types from schemas/constants (INV-31). Centralize constants at the source of truth (INV-33). No hardcoded display text in backend responses — structured data, frontend formats (INV-46).
- `contentJson` (ProseMirror JSONContent) is the canonical internal representation; markdown is a wire format for external callers only. Internal code passes/stores `contentJson`; serialize at the API boundary (INV-58).
- Mentions/channel links resolve to ids at ingestion (INV-64). `attrs.id` is authoritative in stored `contentJson` (`usr_`/`persona_`/`bot_` actors, `stream_` channels, `broadcast:here`/`broadcast:channel` sentinels); `slug` is display-only; backend resolves by id, never slug. Markdown wire format carries the id as a pointer link — `[@slug](user:usr_x)`, `[@slug](persona:persona_x)`, `[@slug](bot:bot_x)`, `[@here](broadcast:here)`, `[#slug](channel:stream_x)` — parsed/serialized in `packages/prosemirror/src/markdown.ts` (same scheme-routing as `attachment:`/`memo:`). Bare `@slug`/`#slug` = lenient input (agent/API authored) and the fallback for unresolved ids; `EventService` runs `resolveMentionContent` on every create/edit (rewrites bare-slug ids, re-derives `content_markdown`) before projections, mention extraction, or the outbox — idempotent, no-op when already resolved. Ambiguous-slug precedence: user › persona › bot.

### AI & Language Behavior

- Only current-gen models from `docs/model-reference.md` (INV-16). All AI calls through `createAI`, never raw SDK (INV-28), always with telemetry metadata (INV-19).
- AI component config lives beside the component in `config.ts`, shared by prod and evals (INV-44); evals call production entry points (INV-45).
- No language-specific heuristics or English-only literals/regexes for semantic decisions — model-based decisions for language-dependent behavior (INV-54).
- Companion sessions are minutes-bounded (INV-65). No long-horizon in-session agent work — anything longer becomes a scheduled follow-up (`agent_follow_ups`, `schedule_follow_up` tool) or a delegation to the user's local agent (`delegated_tasks`, `delegate_task` tool, `features/delegations/`): Threa compiles the hand-off brief, the local agent executes with the user's credentials, completion posts back and GAM memorizes it. No tools/prompts that encourage hours-long in-session work; see `docs/plans/ariadne-collaborator-roadmap.md` Phase 5.
- Memory capture is visible in situ (INV-62). The transaction inserting GAM memo rows also appends a `memos:captured` broadcast timeline event to the source stream with per-memo provenance (`memoId`, `title`, `knowledgeType`, `sourceMessageIds`), rendering and deep-linking to the memory explorer (`?memo=`) without extra fetches. Never silent. Extraction is debounced per stream — the payload's source ids, not event position, are the authoritative link. Event type is in `TIMELINE_BROADCAST_EVENT_TYPES`, so it takes a dense broadcast slot and contiguity (INV-61) covers it.

### Frontend & UX

- Shadcn primitives from `apps/frontend/src/components/ui/` (INV-14). Components UI-focused — no business logic or persistence (INV-15). No component definitions inside components (INV-18). Hints/tooltips/popovers never cause layout shift (INV-21).
- Navigation = `<Link>`, actions = `<button onClick>` — never `onClick={() => navigate(...)}` (INV-40).
- Socket subscriptions always pair with bootstrap fetches; invalidate bootstrap on reconnect/resubscribe to close event gaps (INV-53).
- Dates render in device-local time via `apps/frontend/src/lib/dates.ts` (`formatDate`, `formatTime`, `formatRelative`, `formatFull`) (INV-42). Their `prefs?: TimePrefs` arg is for non-UI contexts only (background jobs, prompt rendering, scheduled notifications) — never force `prefs.timezone` into UI. Exception: agent temporal grounding prefers device timezone (`users.timezone`, socket-heartbeat-fresh) over `preferences.timezone` — `deviceTimezone` option on `buildStreamContext` (`apps/backend/src/features/agents/context-builder.ts`).
- Multi-view pages derive the active view from the URL, not `useState` — refresh/back/shared link lands on the same view (INV-59). Small fixed view sets get route segments (`/saved`, `/saved/done`, `/saved/archived`), tab onChange `navigate(...)`, hook reads `useParams()` with a default.
- Preview surfaces strip markdown before rendering (INV-60): any user-content preview (thread cards, sidebar previews, activity snippets, notification text, quoted snippets, search results) routes `contentMarkdown` through `stripMarkdownToInline()` (`apps/frontend/src/lib/markdown/strip.ts`) or `truncateContent()` (`apps/frontend/src/components/layout/sidebar/utils.ts`) — never raw markdown into a `<span>`. Backend sends raw markdown; frontend strips at render. Reference surfaces: `StreamItemPreview`, `ActivityPreview`.
- Timeline window is verifiably contiguous (INV-61). `TIMELINE_BROADCAST_EVENT_TYPES` (`packages/types`) events consume a dense per-stream `broadcastSequence` allocated by `StreamEventRepository` alongside the global `sequence`; author-scoped command events and patch rows (edits, reactions, deletes) don't — so a missing broadcast number is ALWAYS a real gap, never another user's invisible event. Message-move (the one slot-vacating op) declares `vacatedBroadcastSequences` on its source tombstone. `computeTimelineHoles` (`apps/frontend/src/sync/contiguity.ts`) is the single read-side authority: holes render as in-place loading placeholders (never silent gaps) and trigger scoped backfill. Catch-up cursor has one owner — `SyncEngine.joinStreamForCatchUp` reads it BEFORE joining the room; never re-derive at call sites.
- Success is silent; toasts are for what needs attention (INV-63). No `toast.success` when the UI already shows the result. Toasts: failures (`toast.error`), warnings needing action (`toast.warning`), deferred/offline state (`toast.info`). Actions with no other on-screen signal (clipboard copy, download) confirm in place — swap the trigger's icon to a checkmark, same footprint (INV-21); references: image-gallery toolbar, mobile attachment drawer. Only anchor-less surfaces (closing dropdown, keyboard shortcut) keep `toast.success`, each with an `INV-63-allow:` comment. Guard test: `apps/frontend/src/lib/no-happy-path-success-toast.test.ts`.

### Testing

- Fix failing tests; never dismiss as pre-existing (INV-22). No `.skip()`/`.todo()` (INV-26).
- Assert presence/content of specific events, not counts (INV-23). One object comparison over chains of narrow assertions (INV-24).
- No `mock.module()`/`vi.mock()` on shared modules — scoped `spyOn` against namespace imports (INV-48). Frontend integration tests mount real components and exercise observable behavior (INV-39).

### Hygiene & Scope

- No speculative features, config, or comments (INV-36). Delete dead code immediately (INV-38); no deprecated aliases after renames (INV-49).
- Comments per Output Style above (INV-25). Nested ternaries max one level (INV-47). Colocate variant config; shared behavior on one path (INV-29, INV-43).

### Quick Lookup

- **Persistence:** INV-1, 2, 3, 8, 17, 20, 30, 41, 50, 56, 57, 62, 66, 67
- **Architecture:** INV-4, 5, 6, 7, 9, 10, 11, 12, 13, 27, 34, 35, 37, 51, 52
- **API contracts:** INV-31, 32, 33, 46, 55, 58, 64
- **AI/evals:** INV-16, 19, 28, 44, 45, 54, 65
- **Frontend/UX:** INV-14, 15, 18, 21, 40, 42, 53, 59, 60, 61, 62, 63
- **Testing:** INV-22, 23, 24, 26, 39, 48
- **Hygiene:** INV-25, 29, 36, 38, 43, 47, 49

New invariant: document here with the next id, add enforcing tests, reference it in nearby code where non-obvious.

## Backend Quick Reference

- Handlers validate input, check auth, delegate, format responses; services orchestrate logic and transaction boundaries; repositories are pure data access — first arg a `Querier` (`Pool` | `PoolClient`), map snake_case ↔ camelCase.
- Factory pattern for handler/middleware DI. Single query: `pool`; multiple related reads: `withClient`; multi-op writes: `withTransaction`. Two pools: main (30) + listen (12) so LISTEN can't starve transactions. Handlers throw `HttpError`; middleware formats.
- Deeper guides: `docs/backend/`.

## Frontend Patterns

Cache-only observer for TanStack Query v5 — `enabled: false` alone is not enough:

```tsx
const { data } = useQuery({
  queryKey: someKeys.bootstrap(id),
  queryFn: () => queryClient.getQueryData<SomeType>(someKeys.bootstrap(id)) ?? null,
  enabled: false,
  staleTime: Infinity,
})
```

No direct `queryClient.getQueryData()` in render for reactive reads.

`WorkspaceBootstrap.streams` is `StreamWithPreview[]`, not `Stream[]` — when adding streams to sidebar cache, spread `{ ...stream, lastMessagePreview: null }`.
