---
name: threa-mcp
description: >-
  Use the Threa MCP server's tools well when a Threa workspace is reachable over
  MCP (a `threa` stdio server, tools like whoami / search / send_message /
  claim_delegation). Use when working inside or against a Threa workspace through
  MCP: answering "what did we decide / how do we do X" from workspace memory,
  posting or resuming a conversation, running a delegated task to completion,
  searching messages or attachments, or paging large lists. Covers identity-first
  ordering, memory-before-humans, the conversation resume pattern, the delegation
  claim/update/finish loop with token recovery, the one `search` tool's what
  selection, cursor paging, the 404-may-mean-missing-scope rule, and rate-limit pacing.
---

# Using the Threa MCP tools

The `threa` MCP server wraps one Threa workspace's public API. One key, one workspace, bound at startup. No tool takes a workspace id. Tool results are JSON in the API envelope: a single resource under `data`, a list as `{ data, hasMore, cursor? }`, a search as `{ data: [...] }`. Failures come back as `isError` results carrying `{ code, message, hint? }`.

## Start with `whoami`

Call `whoami` before anything else. It confirms the key works, tells you whether you are a `user` or a `bot` principal, and reports the workspace and base URL you are bound to. Your identity decides what you can do: a user key acts as the person and posts attributed to them; a bot key acts as the bot, and only a bot key can call `request_delegation_access`. Knowing which you are avoids surprises later in the session.

## Refer to streams and users by slug

You rarely need to look up an id first. Any stream argument (`read_stream.stream_id`, `send_message.stream_id`, `search.stream_ids`, `find_messages_by_metadata.stream_id`, `list_conversations.stream_id`, `apply_label.stream_id`, `remove_label.stream_id`) takes a `stream_…` id or a `#channel-slug`. Any user argument takes a `usr_`/`bot_` id or an `@user-slug`. A ref that matches nothing or is ambiguous fails before any API call with `code: "UNRESOLVED_REF"`, listing the candidates or pointing you at `list_streams`/`list_users`; resolution is cached for the session.

Two things you cannot do this way, by design of the API: an `@user-slug` will not stand in for your DM with that user (DM streams hide their counterpart on the wire), and bots/personas are not queryable by slug. For a DM, find its `stream_…` id with `list_streams` (`type: "dm"`) + `read_stream` (`include_members: true`); for a bot/persona, pass its id.

## Payloads name their authors

Read results already carry author identity, so you seldom need a second call to name who said what. Message rows carry `author: { id, type, name, slug? }` (a bot/persona author has no slug and its name comes from `authorDisplayName`). Conversations carry a `participants` array parallel to `participantIds` with each participant's name and slug. Stream members carry name and slug. Use these fields directly instead of calling `list_users` per id.

## Search memory before asking a human

`search` with `what: "memos"` searches GAM, the knowledge Threa extracts from this workspace's conversations: decisions, learnings, procedures, context, references. When the question is "what did we decide", "how do we do X", or "why is it this way", the answer usually already lives there. Search it before you ask a person or guess.

- `query` is semantic by default and optional. Pass the idea you are after even if you do not know the exact wording; leave it empty to browse the most recent memos.
- Set `exact: true` (or wrap the query in double quotes) to match a literal phrase.
- Narrow with `stream_ids`, `knowledge_type`, `memo_type`, `tags`, `scope`, and time bounds.
- Follow a hit with `get_memo` to see the source messages it was extracted from, so you can cite or verify the origin.

## Conversation create and resume

A conversation groups a run of messages under a stream's root. To hold a threaded exchange across multiple sends:

1. On the first send, set `start_conversation: true`. The result includes `conversationId`.
2. Save that `conversationId`.
3. On every later send in the same exchange, pass `conversation_id: <saved id>` instead of `start_conversation`. Do not set both; that is an error before any HTTP call.

The resumed conversation must live under the same root stream as the target, or the API returns 400 `CONVERSATION_NOT_IN_ROOT`. Read a conversation and a page of its messages together with `read_conversation`.

`send_message` auto-generates a `client_message_id` (`mcp-<uuid>`) when you omit one, so a retried send never double-posts. It is returned as `clientMessageId`. To dedup across separate attempts, stamp your own `metadata` (a flat string-to-string map) and check with `find_messages_by_metadata` before posting, for example `{ "github.pr": "org/repo#42" }`.

## The delegation loop

A delegation is a task handed to a local agent. Run the whole loop, and treat the claim token as the thing that keeps the task yours.

1. `list_delegations` shows open tasks. Pass `since` (an ISO-8601 instant) to poll for a cheap delta.
2. Before claiming, generate and **persist an `idempotency_key`** (8 to 128 chars). Then `claim_delegation` with `delegation_id`, a human-readable `claimed_by_label`, and that key. The result carries the brief, the context refs, and a `claimToken` shown once. The server also caches the token in memory for this session.
3. The claim has a 15-minute TTL. Call `update_delegation` before it lapses to renew it, or the task returns to the queue. Pass a `status_note` to also report progress on the card; omit it for a pure heartbeat.
4. Finish with `finish_delegation`. Use `outcome: "complete"` for success (optional `result_markdown` is posted into the delegation's stream so GAM memorizes it, optional `metadata` stamps that message), or `outcome: "fail"` with a required `error_message`.

Token recovery: lifecycle tools reuse the cached token, so you normally omit `claim_token`. If the server restarted since you claimed, the cache is empty and lifecycle calls fail with a missing-token error. Pass `claim_token` explicitly to recover. If you crashed mid-task, re-run `claim_delegation` with the same persisted `idempotency_key`: it re-keys your own live claim and hands back a fresh token and lease instead of a 409. A plain 409 `DELEGATION_NOT_OPEN` means another runner won the race.

If you are a bot key and cannot claim a task because the bot lacks a grant on its stream, call `request_delegation_access` to file an approval card. A user key cannot do this; a user's access follows the person, who should join the stream.

## Choose the right search

One `search` tool covers all three kinds; pick with `what`, and pass only the filters that `what` supports (passing another one is an error that names it).

- **`search` with `what: "messages"`**, default (full-text): you know the words that appear in the message. Add `semantic: true` when you know the idea but not the wording, or `exact: true` to match the query as a literal phrase. `query` is required.
- **`search` with `what: "memos"`**: search workspace memory (see the memory section). `query` is optional and semantic; an empty query browses recent memos.
- **`search` with `what: "attachments"`**: search files by filename or extracted content, then `get_attachment` for the full extracted text, or `get_attachment_download_url` only when you need the raw bytes. `query` is required.
- **`find_messages_by_metadata`**: you want messages by a reference you stamped at send time, not by text. This is exact key/value AND-containment, the right tool for dedup and external-id lookup.

## Paging

Most lists return `{ data, hasMore, cursor }`. When `hasMore` is true, pass `cursor` back as the paging argument (`after` for streams and users, `cursor` for conversations) and repeat until `hasMore` is false. Two exceptions:

- `read_stream` pages its messages by numeric message **sequence**, not a cursor. The messages envelope is `{ data, hasMore }` with no cursor. Walk pages with `before` (older) or `after` (newer), taking the boundary message's `sequence`. Pass at most one. Its member list (with `include_members`) pages by cursor.
- `search` returns `{ data: [...] }` and is bounded by `limit` and time filters rather than a cursor.

## 404 can mean missing scope

Threa hides existence from a key that lacks a scope, so a missing scope returns 404, not 403. If a tool returns 404 for a resource you expect to exist, the key may simply lack the scope for that area (for example `memos:read` for memo tools, `delegations:write` for the delegation lifecycle). The error hint says so. Check the key's scopes before concluding the resource is gone.

## Pace bulk reads

The limit is 60 requests per minute per key. The client already retries a 429 with backoff (2s, 4s, 8s) before giving up, but that burns wall-clock time. When walking many pages or fanning out searches, keep well under 60 calls per minute rather than sprinting into the limit. A 429 is the only automatically retried status (safe for any method — a rate-limited request never executed); any other failure surfaces immediately, so handle transient errors yourself if a call matters.
