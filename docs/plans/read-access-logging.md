# Read/Access Logging — Design

- **Status:** Reviewed — §10 decisions confirmed by Kris 2026-07-18; WorkOS ingestion and enclave notes added same day
- **Date:** 2026-07-18
- **Branch:** `feat/read-access-logging`
- **Related:** `docs/audits/gdpr-audit-2026-07.md` (branch `audit/gdpr-audit`) — this design implements an Art. 32 security measure and the breach-scoping instrument for G-34; it does **not** substitute for the audit's P0 items (transparency G-08..10, erasure G-01..04, transfer control G-14..17, ROPA G-33).

## 1. Goal

A durable, queryable record of **who accessed what data, when, as whom, and from where** — covering humans, agents acting on behalf of humans, external callers (public API / CLI / MCP / bot runtimes), and content egress to AI processors. Plus a uniform record of mutations.

Two queries must be cheap, because they are the breach-notification (Art. 33, 72h) and DSAR-support questions:

1. _Everything actor X touched in window W._
2. _Everyone (and every agent) who touched subject Y._

**Non-goals:** no product UI (deliberately — see §6); not read-receipts (product read state via last-seen cursors is a different concern and must not be conflated); not a replacement for the ROPA document; not coverage of out-of-band infra access (§7).

## 2. Principle: log trust-boundary crossings

An access event is recorded when data **crosses out of the server's trust domain**:

| Crossing               | Examples                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| To a human's device    | REST reads (bootstrap, catch-up, history, search, memos), socket delivery                       |
| To a model provider    | Agent context, GAM classification/extraction, embeddings — anything through `createAI` (INV-28) |
| To an external caller  | Public API, CLI, MCP, bot-runtime sockets                                                       |
| A storage grant        | S3 presigned attachment URLs (the GET then bypasses us)                                         |
| Denied at the boundary | 401/403 and access-hiding 404s — attempted access is a first-class event                        |

Purely internal processing (read projections, contiguity math, queue plumbing) is _processing_, documented in the ROPA, not logged per-operation — otherwise the log drowns in noise. The line is egress: the moment GAM's memorizer sends a conversation to OpenRouter it crosses the boundary and gets a row (which doubles as the per-call transfer record the audit says is missing, G-14).

Client-side re-display from IndexedDB after delivery is out of scope by design: the audit boundary is the server; what a device does with data already delivered is unobservable.

## 3. The socket question: derive delivery, don't materialize it

Live socket delivery is the correct access moment (data left our control), but writing a row per event per member is write amplification with no information gain. Instead:

- **Log subscription intervals.** On stream-room and workspace-room `join` (`apps/backend/src/socket.ts`, already gated by `streamService.validateStreamAccess`), write a `subscribe` row; on `leave` and on disconnect (socket.io knows the socket's rooms), write an `unsubscribe` row. Append-only pair, correlated by a per-connection id (§4).
- **`stream_events` already records what was broadcast** — stream, `sequence`, `created_at`, actor (`20251210155323_core_schema.sql`).
- **Delivered-set = subscription intervals × stream_events.** A conservative upper-bound reconstruction of what every session received, at one row per join instead of one per message per member. It is exact when intervals close cleanly; an unclosed interval (crash → missing unsubscribe, see the edge cases below) over-approximates — the safe direction for breach scoping.

Edge cases:

- _Server crash → missing unsubscribe._ An unclosed interval over-approximates delivery. That is the safe direction for breach scoping (we claim someone _may_ have received more, never less). A periodic sweeper can close orphaned intervals at the pod's last-alive timestamp; not required for v1.
- _Dependency on stream_events retention._ Reconstruction needs only metadata columns (`stream_id`, `sequence`, `event_type`, `created_at`) — not payloads. The P0 erasure work (audit §6) will redact/scrub **payloads**; as long as it preserves row metadata, reconstruction survives. Constraint to carry into that design.
- Catch-up and history are REST anyway (`GET /sync`, `GET /streams/:id/events`, `/events/around` — `routes.ts`), so pull-shaped reads log as explicit **range reads**: `{type:'stream', id, fromSeq, toSeq}`.

## 4. Identity: what goes in the row

All of this already exists per-request; none of it is persisted today.

| Field                     | Source                                                                                                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actor_type` / `actor_id` | Sessions: `req.user.id` (`usr_`, stamped by `apps/backend/src/middleware/workspace.ts`). Public API user keys: `req.user` resolved by `middleware/public-api-auth.ts`. Bot keys: `req.botApiKey.botId` (`bot_`), no acting user. Agents: `persona_`. Background egress: `system` (e.g. `system:gam`).    |
| `on_behalf_of_user_id`    | Agent turns: `invokingUserId` from `features/agents/companion/context.ts` (trigger-message author; `NULL` for bot-triggered turns and system origin). Public-API user keys: NULL — the key's user _is_ the actor.                                                                                        |
| `auth_ref`                | The credential/channel: `uak_`/`bak_` key id, `dlg_` claim, or a **socket-connection id** minted at connect (`sconn_<ulid>`, stamped on `socket.data`). Sessions are stateless WorkOS sealed cookies — there is no server-side session id, so the connection id and request id are the correlation keys. |
| `ip`                      | `req.ip` — real client IP: the workspace-router rewrites `X-Forwarded-For` from `CF-Connecting-IP` (`apps/workspace-router/src/index.ts`), backend sets `trust proxy`. Captured at socket handshake for socket rows.                                                                                     |
| `request_id`              | pino `genReqId` (`apps/backend/src/app.ts`) — inbound `x-request-id` or fresh UUID. Ties a row to operational logs.                                                                                                                                                                                      |
| `user_agent`              | Request header; forensic value, retention-bounded like everything else.                                                                                                                                                                                                                                  |

Sockets today stamp only `socket.data.workosUserId` (`lib/socket-auth.ts`); the join handler already resolves the workspace user for access checks — reuse that resolution to stamp `usr_` on `socket.data` at first join.

## 5. Data model

New backend feature folder `apps/backend/src/features/access-log/` (INV-51): migration, repository, service, HTTP middleware, partition/retention worker, operation constants (INV-33), tests.

```sql
CREATE TABLE access_log (
  id                    TEXT NOT NULL,            -- acc_<ulid> (INV-2)
  workspace_id          TEXT,                     -- NULL only for workspace-less auth-surface rows (INV-8 global exception)
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type            TEXT NOT NULL,            -- 'user' | 'persona' | 'bot' | 'system' (INV-3: TEXT, validated in code)
  actor_id              TEXT NOT NULL,
  on_behalf_of_user_id  TEXT,
  auth_ref              TEXT,                     -- uak_/bak_/dlg_/sconn_ ref
  operation             TEXT NOT NULL,            -- 'streams.catchup', 'search.messages', 'attachments.presign', 'agent.context', ...
  access_kind           TEXT NOT NULL,            -- 'read' | 'write' | 'subscribe' | 'unsubscribe' | 'disclose'
  outcome               TEXT NOT NULL,            -- 'success' | 'denied' | 'error'
  subjects              JSONB,                    -- see below
  detail                JSONB,                    -- operation-specific, content-free (e.g. {provider, model} on disclose)
  ip                    INET,
  user_agent            TEXT,
  request_id            TEXT,
  PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);
```

- **Subjects** are refs, never content: entity refs `{type:'memo'|'attachment'|'user'|'stream'|..., id}`, range refs `{type:'stream', id, fromSeq, toSeq}`, coarse refs `{type:'workspace', id}` (bootstrap). Arrays capped (~100) with an explicit `{type:'overflow', count}` tail — silent truncation would read as complete coverage.
- **The no-content rule is absolute.** No message text, no memo bodies, no search query strings (forensically tempting, but they are user content; storing them would re-create audit finding G-31 inside the audit table). This single rule is what makes retention trivial and keeps erasure (G-01..04) from ever needing to touch this table: refs to deleted rows are inert.
- **Partitioning/retention:** native monthly range partitions, created ahead by the worker; retention = `DROP TABLE` of expired partitions. Proposed horizon: **13 months** (a year of seasonality + one month). The retention worker ships **in the same PR as the table** — the audit's G-05 catalogues our existing no-retention zones; this feature must not add one.
- **Indexes:** per-partition `(workspace_id, occurred_at)`, `(actor_id, occurred_at)`, GIN (`jsonb_path_ops`) on `subjects` — that GIN index is what makes query #2 ("everyone who touched subject Y") cheap.
- No FKs (INV-1). `AccessLogService` is a constructed dependency injected where needed (INV-9/12/13).

**Durability split (as built):** all rows — reads, writes, subscribes, discloses — insert **async best-effort** (fire-and-forget with loud error log; never block or fail the request being audited). Same-transaction write exactness was dropped: threading audit into ~100 service transactions was scope explosion for marginal gain when `stream_events` already is the exact domain record; `AccessLogService.recordSync(querier, entry)` exists as the seam if a future mutation wants it. The outbox itself is _not_ a substitute: it is pruned after 7 days (`packages/backend-common/src/outbox/retention-worker.ts`).

## 6. Who can read the log

Nobody, through the product. The log contains IPs and who-read-what behavioral data — personal data about users (and, once teams onboard, workplace-surveillance-adjacent data about employees; G-28 shows how easily an "admin visibility" surface over-exposes). So:

- No API endpoint, no UI. Controller-level forensics only, via `db-read-proxy`/psql.
- Its own ROPA entry: purpose = security monitoring & breach response, basis = legitimate interest, retention = 13 months, recipients = none.
- On account erasure, rows are retained until partition expiry under the same basis (document this in the privacy policy the P0 transparency work creates).

## 7. Capture points

### 7.1 HTTP middleware + route annotations (the base layer)

Every authed `/api` route declares an audit annotation at registration: `{ operation, kind }` (or `kind: 'none'` with justification — e.g. presence heartbeats). Mechanics:

- Middleware writes the row on response finish: `outcome` from status (401/403 → `denied`; handlers can override for access-hiding 404s), identity from `req`, subjects from `res.locals.auditSubjects` which handlers populate (range refs for catch-up/history, result refs for search, entity refs for single reads).
- **Every authed non-GET logs `kind:'write'` uniformly.** Redundant with `stream_events` for domain events — accepted: one small row buys a single query surface over _all_ mutations, including the non-event-sourced ones (settings, personas, API keys, integrations, memos, delegations) without maintaining a which-is-which list.
- **Coverage guard, or it decays:** a test walks the Express router and fails on any `/api` route without an annotation — same move as the public-API boot-time parity assertion (`features/public-api/mount.ts` + `routes.ts`) and the INV-63 toast guard test. New endpoints cannot silently skip logging.

This base layer covers the public API and CLI/MCP for free (same routes, richer `auth_ref`).

### 7.2 Socket layer

`subscribe`/`unsubscribe` rows per §3; `sconn_` id minted at connect; workspace-user resolution stamped at first join. Bot-runtime sockets (`/bot` namespace, `features/bot-runtimes/socket-auth.ts`) already carry `{keyId, botId, workspaceId}` — same row shape, `actor_type:'bot'`.

### 7.3 AI egress (`disclose`)

One hook in the `createAI` wrapper — the mandatory chokepoint (INV-28) that already requires telemetry metadata (INV-19). Every **workspace-scoped** AI call routed through `createAI` gets a `disclose` row: actor/on-behalf-of from metadata, `operation` from the component name, `detail: {provider, model}`, subjects = source refs where the caller can provide them (agent context: streams/messages read; memorizer: conversation refs). Embedding batches log one row per batch, not per message. Coverage is bounded to that chokepoint: workspace-less egress (evals) is skipped, and the enclave LLM path and voice STT egress are outside `createAI` (documented processor egress, §7.7 / §11). This gives a queryable record of what left to which provider for the covered surface — the accountability layer for audit findings G-14/G-15 until EU pinning lands.

### 7.4 Attachments

`GET /attachments/:id/url` mints a 900s presigned S3 URL (`features/attachments/handlers.ts`) — after that the GET hits S3, not us. The presign **is** the access event: `operation:'attachments.presign'`. The streaming path (`/content`) and extraction-text path log as ordinary reads via 7.1.

### 7.5 Control plane: `auth_log`, fed by the WorkOS Events API

Login had zero logging (`apps/control-plane/src/features/auth/handlers.ts` had no logger calls, and pino is silent on 2xx). A small separate table in the CP database — global scope, so it correctly lives outside workspace sharding (INV-8). As built it is a **plain (non-partitioned) table**: a partitioned table cannot carry a unique index that omits the partition key, which would break pure event-id idempotency — the load-bearing property for replayable ingestion. Auth volume is tiny, so a partial `UNIQUE INDEX ... WHERE workos_event_id IS NOT NULL` plus a batched-DELETE 13-month retention worker is the honest shape.

**The primary source is WorkOS, not our handlers.** AuthKit hosts the login UI, so authentication _failures_ never touch the control plane — our own handlers structurally cannot see them. WorkOS emits everything as events (`authentication.password_failed`, `authentication.oauth_succeeded`, `session.created`, …), consumable via the cursor-paginated Events API — the exact mechanism the authz mirror already runs (`WorkosOrgServiceImpl.listMirrorEvents` → `workos.events.listEvents`, `packages/backend-common/src/auth/workos-org-service.ts`). `auth_log` ingestion is a second cursor consumer beside it. Two properties force ingestion rather than leaning on WorkOS's copy:

- **WorkOS retains events 90 days**; our horizon is 13 months.
- `session.created` carries an **`impersonator` field** when a session starts via WorkOS dashboard impersonation — an operator-access path nothing else in our stack records. Ingesting it closes a hole this design hadn't listed.

Proposed event set: `authentication.*` (all succeeded/failed variants + `radar_risk_detected`), `session.created`/`session.revoked`, `user.created/updated/deleted`, `organization_membership.*`, `invitation.*`, `password_reset.*`, `magic_auth.created`, `email_verification.created`, `api_key.*`. Excluded until relevant: `connection.*`/`dsync.*` (no SSO/SCIM orgs yet — revisit at team onboarding), `flag.*`, role/permission template events (dashboard config, not subject data). Rows store the WorkOS event id for idempotent re-ingestion (`ON CONFLICT` upsert, INV-20 — the Events API is explicitly replayable) and the WorkOS event type verbatim as `operation`. Our own handlers add rows only for what WorkOS can't see (e.g. callback-exchange failures in `authenticateWithCode`). Failed-login rows keep the attempted email (forensic need is real; same 13-month expiry).

### 7.6 db-read-proxy

Today it logs only _failed_ queries. Change: log every executed query's SQL + duration + timestamp (structured stdout; the prod DB connection is `BEGIN READ ONLY`, so it cannot write a table — Railway log retention applies, which the audit lists as unverified). Actor is coarse ("holder of the shared secret", G-30); still closes the biggest observability hole in the out-of-band path.

### 7.7 Enclave reads (E2EE forward-compatibility)

E2EE scratchpads are today verifiably excluded from all AI/memory processing; the enclave is the documented operator-trusted compute exception. If the enclave later gains **workspace-read** capability (so an E2EE scratchpad agent can search regular workspace content), those reads are ordinary trust-boundary crossings and log like any agent's: actor = the enclave runtime/invocation (`elr_`/`einv_` refs), `on_behalf_of_user_id` = the invoking user, subjects = what was read. Two properties of this design carry the privacy story for that feature:

- **The no-content rule means the E2EE-originated query is never persisted** — the log records _that_ the enclave searched and _what results it touched_, never what was asked. A documented, test-guarded policy to point at, rather than an assurance.
- The caveat stays honest: a workspace search still embeds the query (egress to the embedding provider), and that egress gets its `disclose` row like any other AI call. Enclave reads are logged access, not invisible access — which is the fair trade for letting them read at all.

### What stays uncovered (documented gaps)

Direct psql with prod credentials, the Railway console, and DB backups bypass application logging entirely. Mitigation is organizational: a short named list of credential holders in the ROPA, plus the db-read-proxy fix shrinking the day-to-day surface. Push notification payloads are RFC 8291-encrypted to the recipient's own device keys — coarse `disclose` logging for push is deferred (P2 at most).

## 8. Operation naming

Dot-namespaced `feature.action`, enumerated in `features/access-log/operations.ts` as the single source of truth (INV-33), typed via `as const` derivation (INV-31). Initial set (illustrative): `workspace.bootstrap`, `streams.bootstrap`, `streams.history`, `streams.catchup`, `streams.subscribe`, `search.messages`, `search.memos`, `memos.read`, `attachments.presign`, `attachments.content`, `agent.context`, `agent.search`, `gam.extract`, `embeddings.batch`, `auth.login`, `auth.login_failed`.

## 9. Implementation plan

| PR  | Scope                                                                                                                                                                                                   | Notes                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | `features/access-log/`: migration (partitioned table), partition+retention worker, repo/service, HTTP middleware, route annotations for all existing `/api` routes, coverage guard test, denial capture | The bulk. Ships retention with the table.                                                                |
| 2   | Socket layer: `sconn_` ids, workspace-user stamping, subscribe/unsubscribe rows, disconnect handling                                                                                                    | Includes the delivered-set reconstruction query as a tested repo method (it is the breach-scoping tool). |
| 3   | `disclose` hook in `createAI` + subject threading for agent context/tools + attachment presign op                                                                                                       | Metadata extension is additive.                                                                          |
| 4   | Control-plane `auth_log` with WorkOS Events API ingestion (second cursor consumer beside the authz mirror) + db-read-proxy query logging                                                                | Independent. Ingestion cadence well inside WorkOS's 90-day window.                                       |

Each PR carries integration tests; PR 1's guard test is the invariant-enforcement piece. If this pattern holds up in review, the guard rule graduates to a numbered invariant in `CLAUDE.md` ("every authed route declares an audit annotation").

## 10. Decisions (confirmed by Kris, 2026-07-18)

1. **Retention horizon** — 13 months for both `access_log` and `auth_log`.
2. **Search query text** — never stored (no-content rule beats forensic convenience). Result refs + counts only. Also the enabling policy for future enclave workspace reads (§7.7).
3. **Bootstrap granularity** — coarse (`{type:'workspace'}` ref), not per-stream refs; catch-up/history carry the precise ranges anyway.
4. **Embedding disclose rows** — per-batch (not per-message) in v1.
5. **Failed-login email storage** in CP `auth_log` — yes, plaintext, same retention (forensic need is real; hashing defeats the lockout use case).

Still open: the exact WorkOS event subset in §7.5 is a proposal ("all of the identity-relevant set") — trim or extend at PR 4 review.

## 11. As-built notes (2026-07-18)

Implemented on `feat/read-access-logging` as five commits (the §9 "PRs" became sequential build steps in one PR, per review pipeline). Deviations from the text above, all deliberate:

- **Boundary denial backstop.** Middleware that denies before the route-level `audit(...)` runs (`workspaceUser` 403/404, public-API key auth 401) would otherwise leave no trace. `audit.boundary` sits between `auth` and `workspaceUser` (and ahead of public-API key auth): records `auth.boundary_denied` rows — denials only, deduped against route-level capture. Cross-workspace probes and API-key probing are logged; cookie-less unauthenticated 401s deliberately are not (crawler noise; keys are secrets, cookies absent isn't an attempt).
- **Outcome classification:** all 4xx → `denied` (over-approximation is the safe direction), 5xx → `error`. Aborted responses (`close` without `finish`) still record, with `detail.aborted` — bytes may already have egressed.
- **Disclose fires at send**, before the provider await, so a call that errors after transmitting the prompt still gets its row. Subjects ride the existing telemetry-metadata channel (`metadata.subjectRefs`) from the memorizer and the agent loop; embedding batches carry no subjects in v1. Session correlation lives in `detail.sessionId` (`auth_ref` stays credential/channel-only). Workspace-less egress (evals) is skipped with a loud warn.
- **Socket rows** stamp `occurredAt` at the join/leave instant (insert lag must not shrink intervals — under-approximation is the wrong direction); re-joining an open room does not open a second interval.
- **Search POSTs** (`search.messages`, `search.memos`, `attachments.search`) are labeled `access_kind:'read'` despite the mechanical GET/non-GET rule.
- **`workspace_id` is nullable** for the workspace-less auth surface (`/api/auth/me`, workspace list/create) — the INV-8 global-infra exception class.
- **CP `auth_log` poller** skips un-ingestible events (loud error, cursor advances) — one poisoned payload must not stall the entire auth trail; the event stays re-fetchable from WorkOS for 90 days.
- **Event names must match the live Events API catalog, not the SDK union.** The SDK 7.82.0 `EventName` union types `api_key.deleted`; the live API only accepts `api_key.revoked` and 400s the whole `listEvents` call on any unknown name, stalling the poller (hit on first prod deploy, 2026-07-19). The ingested set is validated against https://workos.com/docs/events; the one off-union name carries a scoped widening in `constants.ts`.
- **Round-2 review additions (Sol + Fable, 2026-07-18):** caller-controlled strings are sanitized centrally (subject refs shape-enforced to id-charset with `#redacted` replacement, inbound `x-request-id` validated, IPs `net.isIP`-checked so a garbage `X-Forwarded-For` can never suppress its own audit row); the bot WS verb surface (`bot:hello` bootstrap read, presence/renew/steps/sealed-steps writes) records rows mirroring its annotated REST twins; CP backoffice requests are auth_log-audited per request (platform-admin access to customer data, incl. denials); delivered-set reconstruction is per-CONNECTION (`DISTINCT ON (auth_ref, event)`) — two devices receiving an event are two deliveries; the partition worker runs an eager maintenance pass at start so a lapsed environment regains a writable partition immediately; public-API reads carry subject refs (search results, memo/attachment gets, presign, message ranges) and the search-shaped POSTs are `read`; `AccessLogService.drain()` runs in graceful shutdown ahead of `pool.end()`.
- **Known accepted gaps:** enclave LLM path and voice STT egress are outside `createAI` (documented processor egress, not sink-covered); client-side re-display is out of scope by design; pre-audit app-level middleware (global rate-limit 429s on the session surface) is uncaptured; a handful of secondary AI call sites (boundary extraction, memo classifier, stream naming, image captions, `getLangChainModel`'s custom fetch) disclose without subject refs — follow-up.
- **Volume reckoning (2026-07-19, day one in prod):** the log wrote 96 rows per product event (12,078 access rows vs 126 `stream_events` in the first ~3h). Per-room socket rows were 70% of all rows (129 connections × ~32 bulk-joined rooms × 2 ≈ 8,400 of ~11.5k at measurement); in the steady-state hour sampled, the `commands.list_for_stream` config fetch was another 25% of writes and bot protocol heartbeats 19%, leaving genuine personal-data access at ~15%. Ruling: a connect-time bulk join is ONE access fact with many subjects, not ~30 facts. As rebuilt: successful ws/stream joins coalesce per (workspace, actor) into one `socket.subscribe` row with a subjects array (`SubscribeCoalescer`, 2s window, `occurredAt` at the first join so the window never shrinks the interval; chunked at `SUBJECTS_CAP` instead of truncated), one coalesced `socket.unsubscribe` closes the connection's rooms at disconnect; denied joins and agent-session rooms keep immediate rows. `reconstructDeliveredEvents` pairs by stream containment excluding `agent_session`-ref rows (replacing the single-subject check), accepting both v1 per-room rows and batch rows. Bot protocol heartbeats (presence, renew, steps) record only denied/error outcomes; empty bot-claim polls skip via handler-declared `res.locals.auditSkip` (2xx-only escape hatch — denials always record); `commands.list_for_stream` is `audit.none` (config, no personal data). Every row remains a self-contained write-time fact — derivation from mutable membership was considered and rejected (evidence must not change retroactively, and rows must stay portable to a dedicated store; the join key to product data is the stable ULID, not colocation).
- **Forensic-query notes:** denial rows recorded before a workspace user resolves (boundary rows, denied socket joins) carry the WorkOS `user_…` id as actor, while success rows carry the regional `usr_…` id — query #1 must union both id spaces for an actor. Socket subscribe rows are app-clock stamped while `stream_events.created_at` is DB-clocked; `reconstructDeliveredEvents` therefore widens both interval edges by a documented uncertainty window (`clockSkewToleranceMs`, default 5s) — over-approximation, the safe direction — rather than relying on catch-up range reads to paper over skew.
