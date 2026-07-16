---
name: threa-mcp
description: >-
  Use the Threa MCP server's tools well when a Threa workspace is reachable over
  MCP (a `threa` stdio server, tools like whoami / search_memos / send_message /
  claim_delegation). Use when working inside or against a Threa workspace through
  MCP: answering "what did we decide / how do we do X" from workspace memory,
  posting or resuming a conversation, running a delegated task to completion,
  searching messages or attachments, or paging large lists. Covers identity-first
  ordering, memory-before-humans, the conversation resume pattern, the delegation
  claim/heartbeat/complete loop with token recovery, search-mode selection,
  cursor paging, the 404-may-mean-missing-scope rule, and rate-limit pacing.
---

# Using the Threa MCP tools

The `threa` MCP server wraps one Threa workspace's public API. One key, one workspace, bound at startup. No tool takes a workspace id. Tool results are JSON in the API envelope: a single resource under `data`, a list as `{ data, hasMore, cursor? }`, a search as `{ data: [...] }`. Failures come back as `isError` results carrying `{ code, message, hint? }`.

## Start with `whoami`

Call `whoami` before anything else. It confirms the key works, tells you whether you are a `user` or a `bot` principal, and reports the workspace and base URL you are bound to. Your identity decides what you can do: a user key acts as the person and posts attributed to them; a bot key acts as the bot, and only a bot key can call `request_delegation_access`. Knowing which you are avoids surprises later in the session.

## Search memory before asking a human

`search_memos` searches GAM, the knowledge Threa extracts from this workspace's conversations: decisions, learnings, procedures, context, references. When the question is "what did we decide", "how do we do X", or "why is it this way", the answer usually already lives there. Search it before you ask a person or guess.

- `query` is semantic by default. Pass the idea you are after even if you do not know the exact wording.
- Set `exact: true` (or wrap the query in double quotes) to match a literal phrase.
- Narrow with `stream_ids`, `knowledge_type`, `memo_type`, `tags`, `scope`, and time bounds.
- Follow a hit with `get_memo` to see the source messages it was extracted from, so you can cite or verify the origin.

## Conversation create and resume

A conversation groups a run of messages under a stream's root. To hold a threaded exchange across multiple sends:

1. On the first send, set `start_conversation: true`. The result includes `conversationId`.
2. Save that `conversationId`.
3. On every later send in the same exchange, pass `conversation_id: <saved id>` instead of `start_conversation`. Do not set both; that is an error before any HTTP call.

The resumed conversation must live under the same root stream as the target, or the API returns 400 `CONVERSATION_NOT_IN_ROOT`. Read the current state of a conversation with `get_conversation` and its messages with `get_conversation_messages`.

`send_message` auto-generates a `client_message_id` (`mcp-<uuid>`) when you omit one, so a retried send never double-posts. It is returned as `clientMessageId`. To dedup across separate attempts, stamp your own `metadata` (a flat string-to-string map) and check with `find_messages_by_metadata` before posting, for example `{ "github.pr": "org/repo#42" }`.

## The delegation loop

A delegation is a task handed to a local agent. Run the whole loop, and treat the claim token as the thing that keeps the task yours.

1. `list_delegations` shows open tasks. Pass `since` (an ISO-8601 instant) to poll for a cheap delta.
2. Before claiming, generate and **persist an `idempotency_key`** (8 to 128 chars). Then `claim_delegation` with `delegation_id`, a human-readable `claimed_by_label`, and that key. The result carries the brief, the context refs, and a `claimToken` shown once. The server also caches the token in memory for this session.
3. The claim has a 15-minute TTL. Call `delegation_heartbeat` or `report_delegation_status` before it lapses to renew it, or the task returns to the queue.
4. Finish with `complete_delegation` (optional `result_markdown` is posted into the delegation's stream so GAM memorizes it) or `fail_delegation` with an `error_message`.

Token recovery: lifecycle tools reuse the cached token, so you normally omit `claim_token`. If the server restarted since you claimed, the cache is empty and lifecycle calls fail with a missing-token error. Pass `claim_token` explicitly to recover. If you crashed mid-task, re-run `claim_delegation` with the same persisted `idempotency_key`: it re-keys your own live claim and hands back a fresh token and lease instead of a 409. A plain 409 `DELEGATION_NOT_OPEN` means another runner won the race.

If you are a bot key and cannot claim a task because the bot lacks a grant on its stream, call `request_delegation_access` to file an approval card. A user key cannot do this; a user's access follows the person, who should join the stream.

## Choose the right search

- **`search_messages`, default (full-text)**: you know the words that appear in the message.
- **`search_messages` with `semantic: true`**: you know the idea but not the wording.
- **`search_messages` with `exact: true`**: you want the query matched as a literal phrase.
- **`find_messages_by_metadata`**: you want messages by a reference you stamped at send time, not by text. This is exact key/value AND-containment, the right tool for dedup and external-id lookup.
- **`search_attachments`**: search files by filename or extracted content; then `get_attachment` for the full extracted text, or `get_attachment_download_url` only when you need the raw bytes.

## Paging

Most lists return `{ data, hasMore, cursor }`. When `hasMore` is true, pass `cursor` back as the paging argument (`after` for streams and users, `cursor` for members and conversations) and repeat until `hasMore` is false. Two exceptions:

- `get_messages` pages by numeric message **sequence**, not a cursor. Its envelope is `{ data, hasMore }` with no cursor. Walk pages with `before` (older) or `after` (newer), taking the boundary message's `sequence`. Pass at most one.
- Search tools return `{ data: [...] }` and are bounded by `limit` and time filters rather than a cursor.

## 404 can mean missing scope

Threa hides existence from a key that lacks a scope, so a missing scope returns 404, not 403. If a tool returns 404 for a resource you expect to exist, the key may simply lack the scope for that area (for example `memos:read` for memo tools, `delegations:write` for the delegation lifecycle). The error hint says so. Check the key's scopes before concluding the resource is gone.

## Pace bulk reads

The limit is 60 requests per minute per key. The client already retries a 429 with backoff (2s, 4s, 8s) before giving up, but that burns wall-clock time. When walking many pages or fanning out searches, keep well under 60 calls per minute rather than sprinting into the limit. A 429 is the only automatically retried status (safe for any method — a rate-limited request never executed); any other failure surfaces immediately, so handle transient errors yourself if a call matters.
