---
name: threa-api
description: >-
  Read and write a Threa workspace over the public REST API: search memos (the
  durable record of what a team decided and why) and follow provenance back to
  the source messages, send/edit/search/delete messages, list streams, members
  and users, search attachments, and run the delegated-task loop. Use when
  asked to post to a Threa stream, answer "what did we decide about X" from a
  Threa workspace, drive Threa from CI or a script, or run as a workspace agent.
---

# Threa public API

Threa is workplace chat that keeps the reasoning behind decisions attached to
the conversation, as searchable memos. Everything the product does over HTTP is
reachable with one API key.

Base URL: `https://app.threa.io/api/v1/workspaces/{workspaceId}/…`
(self-hosted deployments swap the host; the path is the same).

The canonical contract is the OpenAPI document — read it rather than guessing a
route or a body shape:

- <https://threa.io/openapi.json> — every endpoint, schema, scope, and error
- <https://threa.io/llms-full.txt> — the whole developer guide in one fetch
- <https://threa.io/auth.md> — how a key is issued and used

## Auth

One key, one workspace, bound when the key is minted. The `{workspaceId}` in
the path must match the key's workspace.

```bash
curl -H "Authorization: Bearer $THREA_API_KEY" \
  https://app.threa.io/api/v1/workspaces/$THREA_WORKSPACE_ID/me
```

`GET /me` needs no scope and names the principal behind the key, so use it to
verify a key before doing anything else. A missing scope returns `403`, or
`404` when the scope is what hides the resource — on an unexpected 404, check
the key's scopes before concluding the thing does not exist.

Keys are created by a workspace member in the app (Settings → API keys, or a
bot's settings for a `threa_bk_…` key). There is no programmatic registration.

## Where to start for a question

Search memos before searching messages. A memo is the distilled decision with
links back to the messages it came from, so it answers "what did we decide and
why" in one hop, where raw message search returns the argument rather than the
outcome.

```bash
curl -X POST -H "Authorization: Bearer $THREA_API_KEY" \
  -H "Content-Type: application/json" \
  https://app.threa.io/api/v1/workspaces/$THREA_WORKSPACE_ID/memos/search \
  -d '{"query":"why did we pause the auth refactor"}'
```

## Writing

Message `content` is markdown. Always set `clientMessageId` on scripted sends —
it is the idempotency key, so a retry or a re-run cannot double-post. Use
`POST /messages/find-by-metadata` to check what a previous run already posted
before sending again.

## Pacing

Limits are rolling 60-second windows: 60 requests per key and 600 per
workspace. For bulk work, pace at 1.5s or more between requests and treat `429`
as retryable with exponential backoff. Spread load across keys rather than
pushing one key past its limit.

## Running as a workspace agent

Threa hands work to outside agents through delegated tasks: claim an open
delegation, work it with your own credentials, heartbeat while you run, and
post the result back. It is pull-based over HTTPS, so it needs no inbound port
and no webhook. The endpoints and the claim-token protocol are in the OpenAPI
document under `/delegations`, with a worked example at
<https://threa.io/developers/recipes.md>.

## Source

Threa is open source and self-hostable: <https://github.com/threahq/threa>.
