---
name: prod-db-readonly
description: >-
  Query the production Postgres database read-only. Use when investigating
  a production data inconsistency, verifying what's actually in a workspace's
  rows (vs. what the API/UI shows), confirming row counts after a backfill,
  diagnosing outbox/queue backlogs, or any other read-only forensic dig
  into the prod database. Two access paths: psql with
  $POSTGRESQL_PROD_READ_ONLY_CONN_STRING from a terminal, or HTTPS via the
  apps/db-read-proxy service when running in a Claude Code web session.
  Not for writes — every layer is read-only.
---

# Prod DB read-only

Two paths to the same read-only Postgres role, depending on where you're running:

| Path | Use from | Credentials |
| ---- | -------- | ----------- |
| **psql direct** | A terminal with raw TCP egress (your laptop, `claude --teleport`) | `$POSTGRESQL_PROD_READ_ONLY_CONN_STRING` |
| **HTTPS proxy** | A Claude Code web session (raw TCP is blocked) | `$DB_READ_PROXY_URL` + `$DB_READ_PROXY_SECRET` |

Both terminate on a Postgres role with `SELECT`-only grants — writes fail
at the DB level. The HTTPS proxy adds extra defense in depth: read-only
transaction, statement timeout, hard row cap, query-shape allow-list.

Use this when the API doesn't expose what you need to see (raw outbox
rows, queue state, exact column values, joins across feature tables) or
when you're chasing a data inconsistency where the API and the DB might
disagree.

## When to reach for psql vs. the API

| Question | Tool |
| -------- | ---- |
| "What does the user see in stream X?" | `threa-public-api` skill (API) |
| "Is there a message with metadata `{foo: bar}`?" | API → `find-by-metadata` |
| "Are there orphaned `messages.author_user_id` with no matching `users.id`?" | psql |
| "How many rows in the `outbox` are unprocessed for workspace W?" | psql |
| "What's the exact value of `contentJson` on this message?" | psql |
| "Why is this background job stuck?" | psql (`queue_messages`, `outbox`) + Railway logs |

Reach for psql when the answer lives in columns the API doesn't return,
or you need an aggregate / join across tables.

## Choosing the access path

`$POSTGRESQL_PROD_READ_ONLY_CONN_STRING` points at a Railway TCP proxy
(`*.proxy.rlwy.net`) and speaks the raw Postgres wire protocol.

- **From a terminal with raw TCP egress** (your laptop or a session
  teleported with `claude --teleport`): use `psql` directly. See
  [Connect (psql direct)](#connect-psql-direct) below.
- **From Claude Code on the web:** raw TCP **does not work at any
  network access level.** Web sessions route all outbound traffic through
  an HTTP/HTTPS-only security proxy — even with the **Full** access
  level, "any domain" means "any HTTPS domain", not "any TCP port". A
  direct `psql` connect will hang and time out. Use the HTTPS proxy
  instead — see [Connect (HTTPS proxy)](#connect-https-proxy).

Quick check (timeout = web sandbox, switch to the HTTPS proxy):

```bash
timeout 5 psql "$POSTGRESQL_PROD_READ_ONLY_CONN_STRING" -tAc 'SELECT 1' 2>&1
```

If the proxy env vars are also missing, fall back to:
1. [`threa-public-api`](../threa-public-api/SKILL.md) for anything the
   public API can answer (messages, streams, members, memos, metadata).
2. [`use-railway`](../use-railway/SKILL.md) with `$RAILWAY_READONLY_TOKEN`
   for backend logs.
3. Ask the user to run the SQL locally and paste the output.

## Safety

- **Read-only role** — writes will error. Don't try to work around this.
- **Real production data** — be careful what you `SELECT *` from; some
  columns (e.g. `messages.content_markdown`, `users.email`) contain
  user-private content. Project only what you need.
- **No `pg_dump`, no exfiltration** — never paste rows containing user
  content into chat, commits, or external systems. Summarize: counts,
  IDs, structural facts. If the user explicitly asks for a row, return
  just the columns they need.
- **Workspace scoping (INV-8):** product/domain tables are sharded by
  `workspace_id`. Always include `WHERE workspace_id = '<id>'` to scope
  diagnostics — running unbounded queries against `messages` or
  `stream_events` will touch every workspace's data and is slow.
- **No transactions left dangling:** psql autocommits each statement by
  default, but if you use `\set AUTOCOMMIT off` or open `BEGIN`, finish
  with `ROLLBACK` (commits would fail under the read-only role anyway,
  but explicit rollback is cleaner).

## Connect (psql direct)

```bash
# One-off query
psql "$POSTGRESQL_PROD_READ_ONLY_CONN_STRING" -c "SELECT current_user, current_database();"

# Tuple-only, no headers (good for piping into jq / wc)
psql "$POSTGRESQL_PROD_READ_ONLY_CONN_STRING" -tAc "SELECT count(*) FROM workspaces;"

# Interactive
psql "$POSTGRESQL_PROD_READ_ONLY_CONN_STRING"

# Run a SQL file
psql "$POSTGRESQL_PROD_READ_ONLY_CONN_STRING" -f /tmp/claude/query.sql
```

Useful psql flags: `-x` (expanded display for wide rows), `-A -t -F $'\t'`
(tab-separated, no headers — easy to pipe), `--set=ON_ERROR_STOP=on` for
scripts.

## Connect (HTTPS proxy)

For web sessions, the same read-only role is reachable over HTTPS through
the `apps/db-read-proxy` service deployed in the production Railway
project. The proxy enforces additional guards on top of the DB role:

- `BEGIN READ ONLY` per query
- `SET LOCAL statement_timeout = 5s`
- Result set hard-capped at 5000 rows (response includes `truncated: true`
  if more were available)
- SQL must start with `SELECT` / `WITH` / `EXPLAIN` / `SHOW` / `VALUES` /
  `TABLE` and be a single statement
- Shared-secret auth via `X-Proxy-Secret` header

```bash
# One-off query
curl -sS -X POST "$DB_READ_PROXY_URL/query" \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Secret: $DB_READ_PROXY_SECRET" \
  -d '{"sql":"SELECT count(*) FROM workspaces"}' | jq .

# Parameterized
curl -sS -X POST "$DB_READ_PROXY_URL/query" \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Secret: $DB_READ_PROXY_SECRET" \
  -d '{"sql":"SELECT id, slug FROM workspaces WHERE id = $1","params":["ws_…"]}' | jq .
```

The response shape is `{ columns: string[], rows: unknown[][], rowCount,
truncated, durationMs }`. Rows come back as arrays (positional), so use
`columns` to map them back when readability matters. Statement-timeout
errors come back as HTTP 504 with `pgCode: "57014"`.

If `$DB_READ_PROXY_URL` / `$DB_READ_PROXY_SECRET` aren't set in the web
session env, the proxy hasn't been wired up yet — fall back to the public
API / Railway logs / ask-the-user path described above.

## Schema crib-sheet

Schema lives in `apps/backend/src/db/migrations/*.sql` — read the latest
migrations there for column-level truth (INV-17). The main domain tables
to know:

| Table | Purpose | Workspace-scoped? |
| ----- | ------- | ----------------- |
| `workspaces` | Workspace rows | (root) |
| `workspace_members` | Workspace ↔ user link with role | yes |
| `users` | Workspace-scoped identity (`UserId`, INV-50) | yes |
| `streams` | Channels, DMs, scratchpads | yes |
| `stream_members` | Stream ↔ user (uses `MemberId`, INV-50) | yes |
| `stream_events` | Append-only event log per stream | yes |
| `messages` | Materialized message rows | yes |
| `attachments` | File metadata (blobs in S3) | yes |
| `memos` | GAM memos (extracted knowledge) | yes |
| `reactions` | Emoji reactions on messages | yes |
| `outbox` | Pending real-time events (INV-4, INV-7) | yes |
| `outbox_listeners` | LISTEN/NOTIFY worker registrations | global |
| `queue_messages` | Background job queue | global |
| `agent_sessions` | Persona/agent run state | yes |

Conventions: column names are `snake_case` (mapped to camelCase in repo
layer); IDs are prefixed ULIDs (INV-2) like `ws_…`, `usr_…`, `stream_…`,
`msg_…`; no DB enums (INV-3) — text columns with app-side validation; no
FKs (INV-1).

## Common diagnostic queries

Workspace + member sanity check:

```sql
SELECT id, slug, name, created_at FROM workspaces WHERE id = $1;

SELECT u.id, u.email, u.role, wm.role AS workspace_role
FROM users u
JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = u.workspace_id
WHERE u.workspace_id = $1
ORDER BY u.created_at DESC;
```

Recent activity in a stream:

```sql
SELECT id, author_user_id, type, sequence, created_at
FROM messages
WHERE workspace_id = $1 AND stream_id = $2
ORDER BY sequence DESC
LIMIT 20;
```

Outbox backlog (real-time delivery delay):

```sql
SELECT
  workspace_id,
  count(*) FILTER (WHERE processed_at IS NULL) AS pending,
  count(*) FILTER (WHERE processed_at IS NULL AND created_at < now() - interval '5 minutes') AS pending_old,
  count(*) FILTER (WHERE failed_at IS NOT NULL) AS failed
FROM outbox
WHERE workspace_id = $1
GROUP BY workspace_id;
```

Queue backlog by job type:

```sql
SELECT job_type, status, count(*)
FROM queue_messages
GROUP BY job_type, status
ORDER BY count DESC
LIMIT 20;
```

Find a message by exact metadata key/value (faster than the API for
forensic deep-dives, but the API's `find-by-metadata` is usually enough):

```sql
SELECT id, stream_id, author_user_id, sequence, created_at
FROM messages
WHERE workspace_id = $1
  AND metadata @> '{"source":"github"}'::jsonb
ORDER BY created_at DESC
LIMIT 50;
```

## Reporting back

When you've found the answer, summarize:

- The query you ran (so the user can re-run / verify).
- Counts / IDs / structural facts — not raw user content.
- If user content is necessary, return only the relevant columns and flag
  it ("includes user-authored text — keep this internal").

For follow-up writes (fixing the bad data), the read-only key cannot
help — escalate to the user and propose the SQL or API call they should
run with a write-capable role.
