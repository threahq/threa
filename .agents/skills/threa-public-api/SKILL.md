---
name: threa-public-api
description: >-
  Call Threa's public REST API (send/list/search/update/delete messages, list
  streams/users/members, search memos/attachments) with curl or a Bun script.
  Use when asked to post messages to a stream, seed a stream with test data,
  drive the API from automation, dedupe by metadata, inspect a production
  workspace (streams, messages, members) for troubleshooting, or otherwise
  hit https://staging.threa.io / https://app.threa.io endpoints with an API
  key. Reads from production should use the read-only prod key.
---

# Threa Public API

The public API is mounted under `/api/v1`. Staging and production share the
same contract:

- **Staging:** `https://staging.threa.io/api/v1`
- **Production:** `https://app.threa.io/api/v1`

Authoritative contract (read these if anything below looks stale — routes are
the single source of truth and a pre-commit check fails on drift):

- `apps/backend/src/features/public-api/routes.ts` — every endpoint, scope, status
- `apps/backend/src/features/public-api/schemas.ts` — request Zod schemas
- `apps/backend/src/features/messaging/metadata-schema.ts` — metadata limits
- `docs/public-api/openapi.json` — generated OpenAPI spec

## Auth

HTTP Bearer. Two keys are pre-provisioned in the runtime env — pick the one
that matches the environment you actually want to hit (do not paste keys
into committed files or chat — read from the env var):

| Env | Base URL var | Workspace var | Key var | Scopes |
| --- | ------------ | ------------- | ------- | ------ |
| Staging | _(use `https://staging.threa.io` directly)_ | _(from app URL)_ | `$THREA_STAGING_TOKEN` | read + write |
| Production | `$THREA_PROD_BASE_URL` (= `https://app.threa.io`) | `$THREA_PROD_DEFAULT_WORKSPACE` | `$THREA_PROD_READ_ONLY_API_KEY` | **read-only** |

```bash
# Staging (writes OK — seeding, load tests, dogfooding)
Authorization: Bearer $THREA_STAGING_TOKEN

# Production (read-only — diagnostics, never seed/spam)
Authorization: Bearer $THREA_PROD_READ_ONLY_API_KEY
```

Key prefixes: `threa_bk_` = bot-scoped (sends as a bot), `threa_uk_` =
user-scoped (sends on behalf of the key owner). The prod read-only key is
`threa_uk_…` (a user key with read scopes only — calls to write endpoints
return 403). The key is bound to one workspace; the `{workspaceId}` in the
path must match it. Each endpoint requires a permission scope (column
below) — a missing scope returns 403/404.

## Workspace & stream IDs

Threa app URLs encode both IDs — copy them straight out:

```
https://staging.threa.io/w/<workspaceId>/s/<streamId>
                            ^^^^^^^^^^^^   ^^^^^^^^^^
```

Or discover via `GET /api/v1/workspaces/{workspaceId}/streams`.

## Endpoints

| Method | Path | Scope | Notes |
| ------ | ---- | ----- | ----- |
| POST | `/workspaces/{ws}/streams/{stream}/messages` | `messages:write` | Send a message. **201**. Body below. |
| GET | `/workspaces/{ws}/streams/{stream}/messages` | `messages:read` | List messages. Query: `before`/`after` (numeric sequence, at most one), `limit≤100` (default 50). |
| PATCH | `/workspaces/{ws}/messages/{messageId}` | `messages:write` | Edit a message you sent via API. Body `{content}`. |
| DELETE | `/workspaces/{ws}/messages/{messageId}` | `messages:write` | Delete a message you sent via API. **204**. |
| POST | `/workspaces/{ws}/messages/search` | `messages:search` | Body `{query, semantic?, exact?, streams?, type?, before?, after?, limit≤50}`. |
| POST | `/workspaces/{ws}/messages/find-by-metadata` | `messages:read` | Body `{metadata:{k:v,…}, streamId?, limit≤100}`. AND-containment — the dedup primitive. |
| GET | `/workspaces/{ws}/streams` | `streams:read` | Query: `type?`, `query?`, `after?`, `limit≤200`. Paginated. |
| GET | `/workspaces/{ws}/streams/{stream}` | `streams:read` | One stream. |
| GET | `/workspaces/{ws}/streams/{stream}/members` | `streams:read` | Paginated. |
| GET | `/workspaces/{ws}/users` | `users:read` | Query: `query?`, `after?`, `limit≤200`. |
| GET | `/workspaces/{ws}/me` | _(none)_ | Identify the principal behind the key. Use to verify a key works. |
| GET | `/workspaces/{ws}/me/bots` | _(none)_ | User keys only — lists caller's personal bots. |
| POST | `/workspaces/{ws}/memos/search` | `memos:read` | |
| GET | `/workspaces/{ws}/memos/{memoId}` | `memos:read` | |
| POST | `/workspaces/{ws}/attachments/search` | `attachments:read` | |
| GET | `/workspaces/{ws}/attachments/{attachmentId}` | `attachments:read` | |
| GET | `/workspaces/{ws}/attachments/{attachmentId}/url` | `attachments:read` | Short-lived signed URL. |

### Send-message body (`sendMessageSchema`)

```json
{
  "content": "markdown string (required, min 1 char)",
  "clientMessageId": "optional, ≤128 chars — idempotency key, dedupes re-runs",
  "metadata": { "github.pr": "https://github.com/o/r/pull/1", "source": "ci" }
}
```

`content` is **markdown** — links unfurl into preview cards server-side.
Always set `clientMessageId` for scripted sends so a retry or re-run can't
double-post. `metadata` is a flat string→string map: keys match
`^[a-zA-Z0-9_.\-:]+$`, ≤64 chars, no `threa.` prefix (reserved); values
≤256 chars; ≤20 keys; ≤4096 serialized bytes. Query it later with
`find-by-metadata` (the canonical "did I already post this?" check).

Success response is `{ "data": { "id": "msg_…", "sequence": "…", … } }`.

## Rate limits

- **60 requests / 60 s per API key**
- **600 requests / 60 s per workspace**

For bulk work pace at **≥1.5 s between requests** (~40/min) and treat HTTP
**429** as retryable with exponential backoff (2s, 4s, 8s, 16s, 32s). Don't
fire 100 requests in a tight loop — you'll get throttled mid-run.

## Recipes

### Verify the key

```bash
# Staging
curl -s -H "Authorization: Bearer $THREA_STAGING_TOKEN" \
  https://staging.threa.io/api/v1/workspaces/<ws>/me

# Production (use the env vars — workspace is pinned by the key)
curl -s -H "Authorization: Bearer $THREA_PROD_READ_ONLY_API_KEY" \
  "$THREA_PROD_BASE_URL/api/v1/workspaces/$THREA_PROD_DEFAULT_WORKSPACE/me"
```

### Production diagnostic snippets (read-only)

When triaging a production issue, the API is the first stop before
reaching for psql. Examples — all use the read-only key:

```bash
BASE="$THREA_PROD_BASE_URL/api/v1/workspaces/$THREA_PROD_DEFAULT_WORKSPACE"
AUTH="Authorization: Bearer $THREA_PROD_READ_ONLY_API_KEY"

# What's in this workspace
curl -s -H "$AUTH" "$BASE/streams?limit=50" | jq '.data[] | {id, name, type}'

# Recent messages in a stream
curl -s -H "$AUTH" "$BASE/streams/<stream_id>/messages?limit=20" | jq '.data'

# Find messages by metadata (e.g. "did our integration post this?")
curl -sX POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/messages/find-by-metadata" \
  -d '{"metadata":{"source":"<integration>"},"limit":20}' | jq '.data | length'
```

### Send one message

```bash
curl -sS -X POST \
  https://staging.threa.io/api/v1/workspaces/<ws>/streams/<stream>/messages \
  -H "Authorization: Bearer $THREA_STAGING_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"hello from the API","clientMessageId":"oneoff-1"}'
```

### Bulk send (the reusable pattern)

For seeding/load/realism runs, use a Bun script — `fetch` is built in. The
pattern: **pre-flight one request and hard-stop on non-2xx** (don't loop 100
auth failures), then throttle, retry 429/network with backoff, and use a
stable `clientMessageId` per item so a re-run is idempotent.

```ts
// bun run seed.ts   (reads $THREA_STAGING_TOKEN from env; never hardcode keys)
const TOKEN = process.env.THREA_STAGING_TOKEN
if (!TOKEN) { console.error("THREA_STAGING_TOKEN required"); process.exit(1) }

const WS = "ws_…", STREAM = "stream_…"
const URL = `https://staging.threa.io/api/v1/workspaces/${WS}/streams/${STREAM}/messages`

async function post(content: string, clientMessageId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content, clientMessageId }),
      })
      if (res.status === 429) { await Bun.sleep(2000 * 2 ** attempt); continue }
      return { ok: res.ok, status: res.status, body: await res.text() }
    } catch (e) {
      await Bun.sleep(2000 * 2 ** attempt)
    }
  }
  return { ok: false, status: 0, body: "exhausted retries" }
}

const items = [/* build your messages here */]

const pf = await post(items[0], "seed-0")
if (!pf.ok) { console.error(`pre-flight failed ${pf.status}: ${pf.body}`); process.exit(1) }

for (let i = 1; i < items.length; i++) {
  await Bun.sleep(1500) // ≥1.5s → under the 60/min per-key cap
  const r = await post(items[i], `seed-${i}`)
  if (!r.ok) console.error(`#${i} failed ${r.status}: ${r.body.slice(0, 300)}`)
}
```

Keep one-off scripts in `/tmp/claude/` — they are not part of the codebase
and must not be committed.

## Safety

- **Staging vs production:** `$THREA_STAGING_TOKEN` is staging-scoped.
  `$THREA_PROD_READ_ONLY_API_KEY` is production but read-only — write
  endpoints (send/edit/delete message) will 403. Never use a write-capable
  prod key without explicit instruction; these endpoints write real,
  user-visible messages.
- **The prod key is owned by a real user.** Calls show up as that user's
  activity in audit/usage logs. Stay on `:read` endpoints unless explicitly
  asked to do something else.
- **Idempotency:** for write paths (staging only by default), always set
  `clientMessageId`; before a re-run consider `find-by-metadata` to check
  what's already posted.
- **Never** commit or echo API keys; read them from the env var.
