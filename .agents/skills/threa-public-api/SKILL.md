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

| Env        | Base URL var                                      | Workspace var                   | Key var                         | Scopes        |
| ---------- | ------------------------------------------------- | ------------------------------- | ------------------------------- | ------------- |
| Staging    | _(use `https://staging.threa.io` directly)_       | _(from app URL)_                | `$THREA_STAGING_TOKEN`          | read + write  |
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

## Versioning

The API is versioned by date (e.g. `2026-07-12`). Each key is pinned to a
version when it is minted, and that pin applies to every request, so you do not
need to send anything. Pass `Threa-Version: <date>` to override the pin for a
single request; a valid header wins over the pin. An unknown value returns
`400` with code `INVALID_API_VERSION` and the known versions in the error.
Every response that resolved a version echoes it in a `Threa-Version`
response header (the 400 for an unknown version has none to echo). The `/api/v1` path prefix is stable and does not change with versions.
The generated changelog is `docs/public-api/CHANGELOG.md`.

`GET .../me` reports the key's version state as `data.apiVersion`
(`{ pinned, resolved, current, supported }`; `pinned: null` means the key is
unpinned and tracks the current version). The pin is changed via the app's key
management API (`PATCH` the key with `{"apiVersion": "<date>"}` or
`{"apiVersion": null}` to unpin), not via the public API.

## Workspace & stream IDs

Threa app URLs encode both IDs — copy them straight out:

```
https://staging.threa.io/w/<workspaceId>/s/<streamId>
                            ^^^^^^^^^^^^   ^^^^^^^^^^
```

Or discover via `GET /api/v1/workspaces/{workspaceId}/streams`.

## Endpoints

| Method | Path                                              | Scope              | Notes                                                                                                                                                                                                |
| ------ | ------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/workspaces/{ws}/streams/{stream}/messages`      | `messages:write`   | Send a message. **201**. Body below.                                                                                                                                                                 |
| GET    | `/workspaces/{ws}/streams/{stream}/messages`      | `messages:read`    | List messages. Query: `before`/`after` (numeric sequence, at most one), `limit≤100` (default 50).                                                                                                    |
| PATCH  | `/workspaces/{ws}/messages/{messageId}`           | `messages:write`   | Edit a message you sent via API. Body `{content}`.                                                                                                                                                   |
| DELETE | `/workspaces/{ws}/messages/{messageId}`           | `messages:write`   | Delete a message you sent via API. **204**.                                                                                                                                                          |
| POST   | `/workspaces/{ws}/messages/search`                | `messages:search`  | Body `{query, semantic?, exact?, streams?, type?, before?, after?, limit≤50}`.                                                                                                                       |
| POST   | `/workspaces/{ws}/messages/find-by-metadata`      | `messages:read`    | Body `{metadata:{k:v,…}, streamId?, limit≤100}`. AND-containment — the dedup primitive.                                                                                                              |
| GET    | `/workspaces/{ws}/streams`                        | `streams:read`     | Query: `type?`, `query?`, `after?`, `limit≤200`. Paginated.                                                                                                                                          |
| GET    | `/workspaces/{ws}/streams/{stream}`               | `streams:read`     | One stream.                                                                                                                                                                                          |
| GET    | `/workspaces/{ws}/streams/{stream}/members`       | `streams:read`     | Paginated.                                                                                                                                                                                           |
| GET    | `/workspaces/{ws}/conversations`                  | `messages:read`    | List AI-clustered conversations, newest activity first. Query: `status?` (`active`/`stalled`/`resolved`), `streamId?` (a channel + its threads), `after?`, `limit≤100` (default 50). Paginated.       |
| GET    | `/workspaces/{ws}/conversations/{conversationId}` | `messages:read`    | One conversation: topic, summary, status, `messageCount`, `participantIds`.                                                                                                                          |
| GET    | `/workspaces/{ws}/conversations/{conversationId}/messages` | `messages:read` | The conversation's messages in assignment order — the context to pull in when a conversation is referenced. `{data}`, primary membership only.                                                    |
| GET    | `/workspaces/{ws}/users`                          | `users:read`       | Query: `query?`, `after?`, `limit≤200`.                                                                                                                                                              |
| GET    | `/workspaces/{ws}/me`                             | _(none)_           | Identify the principal behind the key. Use to verify a key works.                                                                                                                                    |
| GET    | `/workspaces/{ws}/me/bots`                        | _(none)_           | User keys only — lists caller's personal bots.                                                                                                                                                       |
| POST   | `/workspaces/{ws}/memos/search`                   | `memos:read`       |                                                                                                                                                                                                      |
| GET    | `/workspaces/{ws}/memos/{memoId}`                 | `memos:read`       |                                                                                                                                                                                                      |
| POST   | `/workspaces/{ws}/attachments/search`             | `attachments:read` |                                                                                                                                                                                                      |
| GET    | `/workspaces/{ws}/attachments/{attachmentId}`     | `attachments:read` |                                                                                                                                                                                                      |
| GET    | `/workspaces/{ws}/attachments/{attachmentId}/url` | `attachments:read` | Short-lived signed URL.                                                                                                                                                                              |
| GET    | `/workspaces/{ws}/labels`                         | `labels:read`      | The key actor's label catalog: `{labels, assignments}`. Every label is private to its owner.                                                                                                         |
| POST   | `/workspaces/{ws}/labels`                         | `labels:write`     | Create-or-update a label **by name** (idempotent). **201**. Body `{name, color?:"#RRGGBB", emoji?, description?}`. Posting an existing name returns it, applying any appearance fields given.        |
| POST   | `/workspaces/{ws}/labels/assignments`             | `labels:write`     | Apply a label to a resource **by name** (finds-or-creates it, then assigns). **201**. Body `{name, color?, emoji?, description?, resourceType:"stream", resourceId}`. Returns `{label, assignment}`. |
| DELETE | `/workspaces/{ws}/labels/assignments`             | `labels:write`     | Remove a label (by name) from a resource. **204**. Query `?name=…&resourceType=stream&resourceId=…`.                                                                                                 |
| PATCH  | `/workspaces/{ws}/labels/{labelId}`               | `labels:write`     | Edit a label you created. Body any of `{name, color, emoji, description}`.                                                                                                                           |
| DELETE | `/workspaces/{ws}/labels/{labelId}`               | `labels:write`     | Archive a label you created (drops its assignments). **204**.                                                                                                                                        |
| GET    | `/workspaces/{ws}/delegations`                    | `delegations:read` | Open delegated tasks the key can see. Query `since=<ISO>` for a cheap delta. User keys see the user's streams; workspace keys see the bot's channel grants.                                          |
| POST   | `/workspaces/{ws}/delegations/{id}/claim`         | `delegations:write`| Body `{claimedByLabel, idempotencyKey?}`. Returns brief + contextRefs + **`claimToken` (cleartext, once)** + expiry. Lost race → **409**. Persist the idempotencyKey BEFORE claiming: a retry with it re-keys your own live claim (crash recovery).      |
| POST   | `/workspaces/{ws}/delegations/{id}/heartbeat`     | `delegations:write`| Header `X-Threa-Callback-Token: <claimToken>`. Renews the 15-min claim TTL. Gone claim → **404**.                                                                                                    |
| POST   | `/workspaces/{ws}/delegations/{id}/status`        | `delegations:write`| Header token. Body `{statusNote?}` — marks running, note shows on the card, TTL renews.                                                                                                              |
| POST   | `/workspaces/{ws}/delegations/{id}/complete`      | `delegations:write`| Header token. Body `{resultMarkdown?, metadata?}` — posts the result atomically with completion, authored as the key's user (via-API badge) or as the bot for a workspace key; GAM memorizes it. Retries with the same token return the committed outcome. |
| POST   | `/workspaces/{ws}/delegations/{id}/fail`          | `delegations:write`| Header token. Body `{errorMessage}` — shows on the card.                                                                                                                                             |

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

### Labels (by name)

Labels are addressed by their text, not an id — there is no "look up the id
first" step. Every label is private to the key's actor (a user key labels for
the user; a personal bot key labels for its owner).

```bash
BASE="https://staging.threa.io/api/v1/workspaces/<ws>"
AUTH="Authorization: Bearer $THREA_STAGING_TOKEN"
JSON="Content-Type: application/json"

# Create or update a label by name (idempotent). Omit color/emoji/description
# to just ensure it exists; pass them to set/overwrite its appearance.
curl -sS -X POST "$BASE/labels" \
  -H "$AUTH" \
  -H "$JSON" \
  -d '{
    "name": "coding",
    "color": "#64748b",
    "emoji": "💻",
    "description": "Pi remote scratchpads"
  }'

# Apply a label to a stream by name (finds-or-creates the label, then assigns).
# A bare assign reuses an existing "coding" untouched; include color/emoji to
# also set its appearance. Returns { label, assignment }.
curl -sS -X POST "$BASE/labels/assignments" \
  -H "$AUTH" \
  -H "$JSON" \
  -d '{
    "name": "coding",
    "resourceType": "stream",
    "resourceId": "stream_..."
  }'

# Remove a label from a stream by name (query params, not a body). 204.
curl -sS -X DELETE \
  "$BASE/labels/assignments?name=coding&resourceType=stream&resourceId=stream_..." \
  -H "$AUTH"

# List the key actor's labels and their assignments.
curl -s "$BASE/labels" -H "$AUTH" | jq '.'
```

### Bulk send (the reusable pattern)

For seeding/load/realism runs, use a Bun script — `fetch` is built in. The
pattern: **pre-flight one request and hard-stop on non-2xx** (don't loop 100
auth failures), then throttle, retry 429/network with backoff, and use a
stable `clientMessageId` per item so a re-run is idempotent.

```ts
// bun run seed.ts   (reads $THREA_STAGING_TOKEN from env; never hardcode keys)
const TOKEN = process.env.THREA_STAGING_TOKEN
if (!TOKEN) {
  console.error("THREA_STAGING_TOKEN required")
  process.exit(1)
}

const WS = "ws_…",
  STREAM = "stream_…"
const URL = `https://staging.threa.io/api/v1/workspaces/${WS}/streams/${STREAM}/messages`

async function post(content: string, clientMessageId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content, clientMessageId }),
      })
      if (res.status === 429) {
        await Bun.sleep(2000 * 2 ** attempt)
        continue
      }
      return { ok: res.ok, status: res.status, body: await res.text() }
    } catch (e) {
      await Bun.sleep(2000 * 2 ** attempt)
    }
  }
  return { ok: false, status: 0, body: "exhausted retries" }
}

const items = [
  /* build your messages here */
]

if (items.length === 0) {
  console.error("No items to send")
  process.exit(1)
}

const pf = await post(items[0], "seed-0")
if (!pf.ok) {
  console.error(`pre-flight failed ${pf.status}: ${pf.body}`)
  process.exit(1)
}

for (let i = 1; i < items.length; i++) {
  await Bun.sleep(1500) // ≥1.5s → under the 60/min per-key cap
  const r = await post(items[i], `seed-${i}`)
  if (!r.ok) console.error(`#${i} failed ${r.status}: ${r.body.slice(0, 300)}`)
}
```

Keep one-off scripts in `/tmp/claude/` — they are not part of the codebase
and must not be committed.

### Run a delegation (the local-agent loop)

When a Threa persona hands off work with `delegate_task`, a card appears in the
stream and the task sits in the open queue until something claims it. This is
how a local agent picks it up, works it, and posts the result back. Requires
`delegations:read` + `delegations:write`. Works with both key kinds: a
user-scoped key posts the result as you (via-API badge); a workspace (bot) key
posts it as the bot — the shared-runner setup.

Manual walkthrough with curl:

```bash
BASE="https://staging.threa.io/api/v1/workspaces/<ws>"
AUTH="Authorization: Bearer $THREA_STAGING_TOKEN"
JSON="Content-Type: application/json"

# List open delegations in streams you can access.
curl -s "$BASE/delegations" -H "$AUTH" | jq '.data[] | {id, title, streamId}'

# Claim one. The response carries the brief (the full hand-off prompt),
# contextRefs, and claimToken. The token is shown once and cannot be
# retrieved again. 409 DELEGATION_NOT_OPEN means someone else won the race.
curl -sS -X POST "$BASE/delegations/<dlg_id>/claim" -H "$AUTH" -H "$JSON" \
  -d '{"claimedByLabel":"Kris MacBook / Claude Code"}' | jq '.data'

# While working: progress notes land on the card and renew the 15-min claim.
TOK="X-Threa-Callback-Token: <claimToken>"
curl -sS -X POST "$BASE/delegations/<dlg_id>/status" -H "$AUTH" -H "$TOK" -H "$JSON" \
  -d '{"statusNote":"Tests passing, writing the migration"}'

# Done: the result posts to the stream as you (via-API badge) and the card
# flips to Completed in the same transaction, so a cancelled or expired
# claim posts nothing.
curl -sS -X POST "$BASE/delegations/<dlg_id>/complete" -H "$AUTH" -H "$TOK" -H "$JSON" \
  -d '{"resultMarkdown":"Shipped in PR #42. All acceptance criteria pass."}'
```

Connected runtimes (the bot-runtime socket) also receive a `delegation:available`
nudge on the `/bot` namespace when a delegation is created, so a socket-holding
runner reacts instantly and keeps polling only as a backstop.

Scripted runner (Bun). Heartbeat on an interval inside the 15-minute TTL, send
`status` at milestones, and wrap the work in `try/catch/finally` so every exit
path either completes, fails, or lets the claim lapse to `expired`. The card
never shows a stale "Running".

```ts
// bun run delegate.ts <delegationId>   (reads $THREA_STAGING_TOKEN; never hardcode keys)
const TOKEN = process.env.THREA_STAGING_TOKEN
if (!TOKEN) {
  console.error("THREA_STAGING_TOKEN required")
  process.exit(1)
}

const WS = "ws_…"
const BASE = `https://staging.threa.io/api/v1/workspaces/${WS}/delegations`

interface Delegation {
  id: string
  streamId: string
  title: string
  status: string
}

interface ClaimedDelegation extends Delegation {
  brief: string
  contextRefs: string[]
  claimToken: string
  claimExpiresAt: string
}

async function api<T>(path: string, init: RequestInit & { claimToken?: string } = {}): Promise<T> {
  const { claimToken, ...request } = init
  const res = await fetch(`${BASE}${path}`, {
    ...request,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(claimToken ? { "X-Threa-Callback-Token": claimToken } : {}),
    },
  })
  if (!res.ok) throw new Error(`${request.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`)
  const { data } = (await res.json()) as { data: T }
  return data
}

const delegationId = process.argv[2] ?? (await api<Delegation[]>(""))[0]?.id
if (!delegationId) {
  console.log("Nothing open to claim.")
  process.exit(0)
}

const claimed = await api<ClaimedDelegation>(`/${delegationId}/claim`, {
  method: "POST",
  body: JSON.stringify({ claimedByLabel: "Kris MacBook / Claude Code" }),
})
console.log(`Claimed "${claimed.title}", expires ${claimed.claimExpiresAt}`)

const { claimToken } = claimed
const heartbeat = setInterval(() => {
  api(`/${claimed.id}/heartbeat`, { method: "POST", claimToken }).catch(() => clearInterval(heartbeat))
}, 5 * 60 * 1000)

try {
  await api(`/${claimed.id}/status`, {
    method: "POST",
    claimToken,
    body: JSON.stringify({ statusNote: "Started, reading the brief" }),
  })

  // The actual work: claimed.brief is a self-contained prompt. Feed it to your
  // agent (claude -p, a Claude Code session, whatever runs on this machine)
  // and collect its final report as markdown.
  const resultMarkdown = await runAgent(claimed.brief, claimed.contextRefs)

  await api(`/${claimed.id}/complete`, {
    method: "POST",
    claimToken,
    body: JSON.stringify({ resultMarkdown }),
  })
  console.log("Completed. Result posted to the stream.")
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error)
  await api(`/${claimed.id}/fail`, {
    method: "POST",
    claimToken,
    body: JSON.stringify({ errorMessage: errorMessage.slice(0, 2000) }),
  })
  throw error
} finally {
  clearInterval(heartbeat)
}
```

Every transition is visible on the delegation card (and in the stream's
"In this stream" panel) as it happens. The completion message goes through the
normal pipeline, so workspace memory extracts the outcome.

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
