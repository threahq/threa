---
title: Memo Pipeline (GAM)
status: shipped
audience: internal
kind: subsystem
invariants: [INV-4, INV-7, INV-41, INV-44, INV-57]
entry_points:
  - apps/backend/src/features/conversations/boundary-extraction/llm-extractor.ts
  - apps/backend/src/features/memos/accumulator-outbox-handler.ts
  - apps/backend/src/features/memos/service.ts
  - apps/backend/src/features/memos/config.ts
  - apps/backend/src/features/memos/repository.ts
  - apps/backend/src/db/migrations/20251226203429_memos.sql
public_site: false
summary: >
  Conversations are extracted into memos: short abstracts that point back to the
  source messages instead of copying them. Boundary detection groups messages into
  conversations, a per-stream debounce batches them, and a classify-then-memorize
  pass writes memos plus their embeddings in one transaction.
related: [architecture/outbox-pattern.md]
---

## The gist

A memo is a row in the `memos` table: a `title`, a one-paragraph `abstract`, a few
`key_points`, a `knowledge_type`, some `tags`, and an `embedding`. The important field
is `source_message_ids`: the ids of every message that informed the memo. A memo does
not copy message content. It is a semantic pointer back to the conversation it came from,
so retrieval lands you on the original thread (`apps/backend/src/db/migrations/20251226203429_memos.sql:9`).

The pipeline that fills this table is GAM (General Agentic Memory). It runs in two stages
that are easy to conflate but are separate subsystems:

1. **Boundary extraction** turns the raw message stream into conversations. Every
   user message triggers a model call that decides which conversation(s) it belongs to,
   and can move earlier messages if the new one reveals they were misfiled. This lives
   under `features/conversations/boundary-extraction/`, not under memos.
2. **Memo extraction** turns settled conversations into memos. When a conversation is
   created or updated, it gets queued. A per-stream debounce waits for the conversation
   to settle, then a classifier decides whether it holds durable knowledge, and a
   memorizer writes the memos.

So the trigger for memos is a conversation event, never a raw message. Boundary
extraction is the thing that watches messages; the memo side only ever sees conversations
(`apps/backend/src/features/memos/accumulator-outbox-handler.ts:45`).

## How it works

**Messages become conversations.** A `message:created` outbox event reaches
`BoundaryExtractionHandler`, which dispatches a `boundary.extract` job. The job calls
`openrouter:openai/gpt-5.4-nano` at temperature 0.2 with the active conversations and
recent messages, and the model returns assignments (which conversation the new message
joins), optional reassignments (earlier messages to move), a new-topic title when it
starts a fresh conversation, and completeness updates
(`apps/backend/src/features/conversations/boundary-extraction/config.ts:12`,
`apps/backend/src/features/conversations/boundary-extraction/llm-extractor.ts`). Creating
or updating a conversation emits a `conversation:created` or `conversation:updated`
outbox event.

**Conversations get queued and debounced.** `MemoAccumulatorHandler` listens for those
two conversation events. It inserts a row into `memo_pending_items` (deduped on
`(workspace_id, item_type, item_id)`) and bumps `last_activity_at` in `memo_stream_state`
(`apps/backend/src/features/memos/accumulator-outbox-handler.ts:49`). A `memo.batch-check`
job, scheduled every 30 seconds, finds streams with pending items whose debounce has
elapsed and dispatches a `memo.batch-process` job per stream. The per-stream debounce is
two-sided: process after 30 seconds of quiet, but at most once every 5 minutes under
sustained activity (`apps/backend/src/db/migrations/20251226203429_memos.sql:81`).

**Batch processing is three phases, and holds no DB connection during the model calls.**
`MemoService.processBatch` is the core (`apps/backend/src/features/memos/service.ts:98`):

- Phase 1 (`withClient`, fast reads): load the pending items, the conversations and their
  messages, the existing active memos for the stream, the workspace tag set, and author
  timezones. Messages are pre-formatted here, while a connection is available, because
  formatting resolves author names (`service.ts:134`).
- Phase 2 (no connection held, seconds): for each conversation, the classifier decides if
  it is knowledge-worthy and whether existing memos need revision; if it passes, the
  memorizer writes the memo set; then all abstracts are embedded in one batched call.
- Phase 3 (one `withTransaction`): insert every memo, set its embedding, write a
  `memo:created` outbox event per memo, and mark the pending items processed
  (`service.ts:359`).

If you only need the model, stop here. The rest is the gating and the gaps.

## Details worth knowing

### What gets skipped, and what waits

Three gates sit in Phase 2 and decide whether a conversation produces anything
(`service.ts:195`):

- **Too short.** Conversations below `MIN_CONVERSATION_MESSAGES` are skipped outright.
- **Young single-message conversations are deferred, not skipped.** A one-message
  conversation younger than `MEMO_SINGLE_MESSAGE_AGE_GATE_MS` (10 minutes) is left
  unprocessed so replies have time to arrive. It is not marked processed, so the next
  30-second check picks it up again. These retries are cheap: the deferral happens before
  any model call (`config.ts:55`, `service.ts:200`).
- **Not knowledge-worthy, or low confidence.** The classifier returns
  `isKnowledgeWorthy` plus a `confidence`. A false verdict skips the conversation; a
  confidence below `MEMO_GEM_CONFIDENCE_FLOOR` (0.7) also skips it (`config.ts:48`,
  `service.ts:248`).

A conversation that passes is capped at `MEMO_MAX_PER_CONVERSATION` (5) memos, on the
theory that a runaway count means the model is transcribing turns rather than extracting
durable knowledge (`config.ts:63`).

### Revision is additive, not superseding

When a stream already has active memos for a conversation, the classifier also returns
`shouldReviseExisting`. If it says no revision is needed, the conversation is skipped and
the existing memos are left untouched. If it says yes, the memorizer runs in revision mode:
it sees the existing memos in context and emits only what is new or changed
(`service.ts:265`). What it does not do is supersede or link. New memos are inserted as
fresh rows; the old ones stay `active`. The `status` lifecycle
(`draft|active|archived|superseded`), `version`, `parent_memo_id`, and `revision_reason`
columns all exist in the schema, but nothing in the write path advances a memo past its
first version today.

### Two model components, one config file each (INV-44)

Both the classifier and the memorizer run `openrouter:openai/gpt-5.4-nano`, at
temperatures 0.1 and 0.3, with prompts and schemas in
`apps/backend/src/features/memos/config.ts`. Boundary extraction keeps its own config next
to its code at `features/conversations/boundary-extraction/config.ts`. The five knowledge
types (`decision`, `learning`, `procedure`, `context`, `reference`) are a shared constant,
`KNOWLEDGE_TYPES` in `packages/types/src/constants.ts`, not redefined per call site
(INV-33).

### Embeddings and search

Memo abstracts are embedded with `openrouter:openai/text-embedding-3-small` into a
`vector(1536)` column with an HNSW index (`embedding-config.ts:8`,
`migrations/20251226203429_memos.sql:30`). There is a second, independent embedding path:
`EmbeddingHandler` listens for `message:created` and embeds individual message bodies for
message-level search; it skips E2E streams, system messages, and empty content
(`apps/backend/src/features/memos/embedding-outbox-handler.ts:89`). Memo retrieval itself
(semantic, full-text, and the RRF hybrid with a structural boost and a fail-open reranker)
lives in `repository.ts` and `explorer-service.ts`. That retrieval side is its own
subsystem and is out of scope for this doc.

### Why the tracking tables exist (INV-57)

The debounce state does not live on conversations or memos. `memo_pending_items` is the
work queue and `memo_stream_state` holds the per-stream timing. Transient pipeline state
stays in its own tables rather than as columns on a core domain entity, which is what
INV-57 asks for.

## Boundaries

- **Memos come from conversations only.** The schema supports `memo_type = 'message'`
  with a `source_message_id`, and the constraint and indexes for it exist, but no code path
  creates a message memo. Every memo written today is `memo_type = 'conversation'`
  (`service.ts:314`). The `parent_memo_id` rollup that would link a message memo into a
  conversation memo is likewise schema-only.
- **No supersession.** As above, revisions add rows; they never archive or version the
  memos they revise.
- **Stubs are test-only.** `StubMemoService`, `StubEmbeddingService`, and
  `StubBoundaryExtractor` replace the AI components when `useStubAI` /
  `useStubBoundaryExtraction` are set. Those flags gate test and local runs, not
  production. In production the pipeline runs unconditionally.

> Drift note: `docs/core-concepts.md` still describes an earlier design (a message-queuing
> "MemoAccumulator", Claude Haiku 4.5 / Sonnet 4.5, a 30-second message debounce). The
> shipped pipeline is conversation-centric and runs `gpt-5.4-nano` for both the classifier
> and the memorizer. This doc reflects the code; core-concepts.md is scheduled to migrate
> into `concepts/` per the inventory.

## Invariants

- **INV-4** memo creation is announced through a `memo:created` outbox event, not an
  ad-hoc publish (`service.ts:328`).
- **INV-7** the memos, their embeddings, and the outbox events all commit in the single
  Phase 3 transaction (`service.ts:359`).
- **INV-41** no DB connection is held during the classify, memorize, or embed calls; reads
  happen in Phase 1 and writes in Phase 3 (`service.ts:90`).
- **INV-44** classifier, memorizer, and boundary-extraction config each sit next to their
  component and are shared by production and evals.
- **INV-57** debounce and queue state live in `memo_pending_items` and `memo_stream_state`,
  not on conversations or memos.

## Entry points

- `apps/backend/src/features/conversations/boundary-extraction/llm-extractor.ts` the model
  call that groups messages into conversations, with config in the sibling `config.ts`.
- `apps/backend/src/features/memos/accumulator-outbox-handler.ts` listens for conversation
  events, queues pending items, tracks per-stream activity.
- `apps/backend/src/features/memos/service.ts` `MemoService.processBatch`, the three-phase
  classify / memorize / save batch.
- `apps/backend/src/features/memos/config.ts` model ids, temperatures, confidence floor,
  caps, prompts, and schemas (INV-44).
- `apps/backend/src/features/memos/repository.ts` memo storage and the semantic / full-text
  / hybrid search used by the explorer.
- `apps/backend/src/db/migrations/20251226203429_memos.sql` the `memos`,
  `memo_pending_items`, and `memo_stream_state` tables.
