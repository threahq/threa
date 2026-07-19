---
title: Access Logging
status: shipped
audience: internal
kind: subsystem
invariants: [INV-8, INV-20]
entry_points:
  - apps/backend/src/features/access-log/middleware.ts
  - apps/backend/src/features/access-log/service.ts
  - apps/backend/src/features/access-log/repository.ts
  - apps/backend/src/db/migrations/20260718121300_access_log.sql
  - packages/backend-common/src/partition/monthly.ts
  - packages/agent-runtime/src/ai/ai.ts
  - apps/control-plane/src/features/auth-log/poller.ts
public_site: false
summary: >
  A content-free audit trail of trust-boundary crossings: every HTTP read, write,
  and denial, socket delivery as subscription intervals, AI egress at send, and
  WorkOS auth events, queryable by actor or by subject for breach scoping.
related: [architecture/outbox-pattern.md, architecture/sync-log.md]
---

## The gist

Two forensic questions drive this subsystem: everything actor X touched in window W,
and everyone who touched subject Y. Both must be cheap SQL, because they are what a
GDPR breach notification (72 hours) and a data subject access request actually ask.

The rule for what gets a row is the trust boundary: data leaving the server's control.
To a human's device (an HTTP read, a socket delivery), to a model provider (any AI
call), to an external caller (public API, bot socket), or as a storage grant (an S3
presign). Denials are first-class: an attempted access that was refused is exactly
what an investigation wants to see. Internal processing (projections, queue plumbing)
gets no rows; that belongs in the processing register, not the log.

One rule is absolute: no content. Rows carry ids, ranges, and refs, never message
text, memo bodies, or search query strings. That single property is what makes
13-month retention safe, keeps erasure from ever touching this table, and lets the
log itself avoid becoming the honeypot it is meant to guard.

There are two stores by design. The regional `access_log` holds workspace-scoped
access and stays in the workspace's region. The control-plane `auth_log` holds
identity events (logins, impersonation, backoffice access), because auth frequently
has no workspace to route by: a failed login for an unknown email belongs to no
region. There is deliberately no UI; querying is controller-only forensics via psql
or the db-read-proxy, because who-read-what is itself personal data.

## How it works

**The table.** `access_log` (migration `20260718121300_access_log.sql`) is a
declaratively partitioned table: monthly `RANGE` partitions on `occurred_at`,
primary key `(occurred_at, id)`, indexes declared on the parent including a GIN
`jsonb_path_ops` index on `subjects` that makes the by-subject query a containment
lookup. Columns: actor (`actor_type`/`actor_id`, one of user, persona, bot, system),
`on_behalf_of_user_id` for agent turns, `auth_ref` (the credential or channel:
`uak_`/`bak_` key ids or the per-socket `sconn_` connection id), `operation`
(dot-namespaced, enumerated in `operations.ts`), `access_kind` (read, write,
subscribe, unsubscribe, disclose), `outcome` (success, denied, error), `subjects`
(capped ref array), `detail`, `ip`, `user_agent`, `request_id`. `workspace_id` is
null only for the workspace-less auth surface such as `/api/auth/me`.

**HTTP capture.** Every `/api` route carries an `audit(operation, kind)` middleware
marker (`features/access-log/middleware.ts`). One response-done hook per request
builds the row: identity resolved in precedence order (bot API key, user API key,
workspace user, WorkOS auth user), outcome from status (all 4xx map to denied, which
over-approximates in the safe direction; 5xx to error), subjects from
`res.locals.auditSubjects` that content-bearing handlers populate (sequence ranges
for stream reads, result refs for search, coarse workspace refs for bootstrap).
Aborted responses (close without finish) still record, because bytes may already
have left. Inserts are fire and forget with loud error logging and a bounded drain
at shutdown; an audit insert never blocks or fails the request it describes. Writes
are captured the same way; `stream_events` remains the exact domain record for
message-shaped writes.

**The boundary backstop and the boot guard.** Middleware that denies without calling
`next()` (workspace membership, public API key auth) would otherwise bypass the
route-level hook, so `audit.boundary` sits ahead of those checks and records
`auth.boundary_denied` rows for cross-workspace probes and bad-key attempts.
`assertAuditCoverage` walks the Express router at boot and throws on any `/api`
route without an annotation, and on any mounted sub-router (Express 5 hides mount
paths, so strictness forces a conscious guard extension). A new endpoint cannot
silently skip logging: the server refuses to start.

**Sockets: coalesced intervals, not per-event or per-room rows.** A `sconn_`
connection id is minted at connect. A client bulk-joins its whole sidebar within
a second of connecting, and that is one access fact with many subjects: successful
workspace and stream joins coalesce per (workspace, actor) into a single
`subscribe` row whose `subjects` array carries every joined ref
(`SubscribeCoalescer`, 2 second window, chunked at the subjects cap rather than
truncated). The row's `occurred_at` is the first join's instant, so the window
never shrinks the interval. Disconnect writes one coalesced `unsubscribe` closing
all of the connection's rooms; an explicit mid-session leave writes its own row.
Denied joins and agent-session rooms record immediately and individually. The
delivered set stays derived, not materialized: `reconstructDeliveredEvents` joins
the intervals against `stream_events` metadata (never payloads) at query time,
pairing any subscribe/unsubscribe rows that contain the stream ref and carry no
`agent_session` ref, which accepts both the batch rows and the per-room rows
written before coalescing landed. Interval edges are widened by a clock-skew
tolerance (default 5s) because subscribe rows are app-clock stamped while events
are DB-clocked; unclosed intervals count as open, which over-approximates. The
bot `/bot` namespace records its rooms the same way; of its verb surface, only
the hello bootstrap records success rows. Presence beats, claim renewals, and
step appends are protocol cadence, not data access, and record only their denied
and error outcomes. The same rule holds on HTTP: an empty bot-claim poll skips
its row through a handler-declared no-op (denials always record), and pure
config reads like the slash-command list are `audit.none`.

**AI egress.** `createAI` accepts an injectable `AccessLogSink`
(`packages/agent-runtime/src/ai/ai.ts`); the backend adapter maps each call to an
`ai.<functionId>` disclose row. It fires at send, before the provider await, so a
call that errors after transmitting the prompt still records. Subject refs ride the
existing telemetry metadata channel from the memorizer and the agent loop, so
"did stream S's content go to a provider" is a subjects query. Rows carry provider
and model in `detail`; embedding batches record once per batch.

**The control-plane `auth_log`.** WorkOS hosts the login UI, so authentication
failures and `session.created`'s impersonator field exist only as WorkOS events,
retained there 90 days against our 13 months. `AuthLogPoller` ingests a validated
event set through a cursor beside the existing authz mirror, idempotent on the
WorkOS event id (`ON CONFLICT DO NOTHING`, INV-20); an un-ingestible event is
skipped with a loud error rather than stalling the trail. Two failures WorkOS
cannot see (callback exchange, magic-auth verify) get own-handler rows, and every
backoffice request records with method, path, and status. The db-read-proxy logs
each executed query to stdout.

If you only wanted the mental model, you can stop here.

## Details worth knowing

- **Partition lifecycle.** `PartitionMaintenanceWorker` (backend-common, Ticker
  shape) runs an eager pass at start and then every 6 hours: provisions two months
  ahead, drops partitions past 13 months. DDL runs under `SET LOCAL
lock_timeout='5s'` on a held client with guaranteed rollback, because partition
  create/drop takes ACCESS EXCLUSIVE and an unbounded wait behind a long forensic
  read would queue every insert into pool exhaustion. All operations are idempotent
  and run on every pod without leader election.
- **Sanitizers.** Caller-controlled strings cannot poison the log: subject ids are
  shape-enforced (non-id-shaped values become `#redacted`), inbound `x-request-id`
  is validated, IPs go through `net.isIP` so a garbage `X-Forwarded-For` can never
  make the INET cast reject the row it belongs to. Subjects cap at 100 with an
  explicit overflow marker so truncation never reads as complete coverage.
- **Denial semantics.** The dominant stream denial is the access-hiding 404 from
  `validateStreamAccess`, which is why 404 maps to denied. Cookie-less anonymous
  401s on the session surface are deliberately not logged (crawler noise, no
  identity to attribute); failed API-key attempts are, because keys are secrets.
  Denied agent-session joins record only the session ref the prober supplied; the
  stream ref is added only after validation proves it belongs to the workspace.
- **Canonical queries.** `AccessLogService.listByActor` and `listBySubject`
  (workspace-scoped, INV-8, with an explicit null branch for the auth surface) are
  the two breach-scoping entries; `reconstructDeliveredEvents` is the delivery
  forensics tool. Correlation across the two stores uses the WorkOS user id and IP.
- **`auth_log` is a plain table**, not partitioned: a partitioned table cannot hold
  a unique index that omits the partition key, and event-id idempotency is the
  load-bearing property for replayable ingestion. Auth volume is small; retention
  is a batched DELETE worker.
- **The coupling contract: stable ids, not colocation.** Every row is a
  self-contained write-time fact; nothing in the log is derived from mutable
  product state, so the evidence never changes retroactively. The log identifies
  records by prefixed ULIDs and sequence ranges; the product database is the
  inventory of what those records contained. The exact-event-id join
  (`reconstructDeliveredEvents` against `stream_events`) is an enrichment that
  works wherever both id spaces are resolvable, not a dependency on living in the
  same database. Any export or migration of audit data to a dedicated store must
  preserve id resolvability, and the monthly partitions are the export seam: a
  closed partition can be detached and shipped whole.
- **Proportionality.** Row volume must scale with access performed, not with
  connection churn or protocol cadence. Day one in production wrote 96 rows per
  product event, dominated by per-room socket rows, a per-stream-switch config
  fetch, and bot heartbeats; the coalesced socket capture, the heartbeat and
  empty-poll exclusions, and the config-read exemption exist to hold that ratio
  near 1. When adding capture, ask what fact the row states that an existing row
  does not.

## Boundaries

- No UI and no API for reading the log, deliberately. Forensics is psql or the
  db-read-proxy.
- A handful of secondary AI call sites (boundary extraction, memo classifier,
  stream naming, image captions) disclose without subject refs; the enclave LLM
  path and voice STT egress sit outside `createAI` entirely. All are listed as
  follow-ups in the design doc's as-built notes.
- Pre-route middleware on the session surface (the global rate limiter's 429s) is
  not captured.
- Suspicious-behavior detection and alerting do not exist yet; the log is the raw
  material. The sketched follow-up is detection workers per store posting
  content-free alerts to a security stream.
- The deploy-day watch items all cleared on 2026-07-19: the partitioned-table
  migration, the maintenance worker's eager first tick, and (after an event-name
  fix, since the SDK's EventName union lags the live API catalog) the first real
  WorkOS ingestion. Event names in `AUTH_LOG_EVENT_TYPES` are validated against
  the live catalog at workos.com/docs/events, not the SDK types: one rejected
  name fails the whole listEvents call and stalls the poller.
- db-read-proxy queries log to stdout (Railway retention applies), not to a table:
  the proxy's connection is read-only by construction.

## Invariants

- INV-8: every workspace-scoped row and query carries the workspace filter; the
  workspace-less auth surface is the documented exception class.
- INV-20: WorkOS event ingestion is idempotent via `ON CONFLICT` on the event id.
- The subsystem's own rule, enforced at boot by `assertAuditCoverage`: every `/api`
  route declares an audit annotation or the server does not start.

## Entry points

- `apps/backend/src/features/access-log/` (middleware, service, repository,
  operations, subjects, AI sink adapter)
- `apps/backend/src/db/migrations/20260718121300_access_log.sql`
- `packages/backend-common/src/partition/` (monthly helpers, maintenance worker)
- `packages/agent-runtime/src/ai/ai.ts` (the `AccessLogSink` seam)
- `apps/control-plane/src/features/auth-log/` (mapper, poller, retention,
  backoffice audit)
- `docs/plans/read-access-logging.md` (design plus as-built deviations, section 11)
