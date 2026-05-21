# Conversation Multi-Membership and Reassignment Plan

## Context

Boundary extraction today is committal and irreversible. For each new message, `BoundaryExtractionService.processMessage` (`apps/backend/src/features/conversations/boundary-extraction-service.ts:45`) asks the LLM to pick exactly one conversation to join (or start a new one), writes that assignment, and moves on. Two structural problems follow:

1. **Single membership.** A message can only belong to one conversation. Cross-topic messages ("ping on the deploy + heads up on the migration") have to be force-fit into one bucket. Thread root messages can never simultaneously belong to the thread's conversation and the parent channel's conversation, even though semantically they do.
2. **No reassignment.** Boundary decisions are made on the information available at message time. When a follow-up message arrives that retroactively reveals "those last three messages were actually a different topic", we have no mechanism to move them. The audit script added in 57dc5f2 (`scripts/analyze-conversation-boundaries.ts`) flags this class of failure on prod data: sandwiched conversations, premature `resolved` status, adjacent topical overlap.

The product mental model the user wants is: **when a new message clarifies what was happening, the prior messages should move to where they now make more sense, not stay stranded in the wrong conversation.**

Failure modes the audit script already detects, and which this plan exists to fix:

- **Sandwich:** A 1-2 message conv lives between two larger convs on the same topic. The middle messages should have joined the surrounding conv (or been pulled into a new one with their successors).
- **Premature resolved:** A conv gets marked `resolved` at message N, then messages N+1..N+k continue the topic. New messages spawned a fresh conv instead of reopening / extending the original.
- **Topical overlap:** Adjacent active convs cover the same topic because the classifier didn't have enough signal at the time to merge them.
- **Cross-topic single message:** One message spans two ongoing threads (e.g. a manager doing parallel pings). Today it picks one and the other loses signal.

## Goal

1. A message can belong to **≥1 conversation** ("multi-membership").
2. Each new-message classification call can also return **reassignments** of recent messages whose original placement no longer fits ("reassignment in light of new evidence").
3. Both behaviors apply across **all stream types** (channels, scratchpads, DMs, threads). Threads lose their deterministic single-conv shortcut and go through the same multi-assignment path; the parent message conv becomes a natural secondary assignment rather than a fallback.
4. The change preserves the three-phase pattern (INV-41) — no DB connection held during the AI call — and the existing transactional commit-with-outbox property (INV-7).

## Core Design Decisions (locked)

These were decided in the planning conversation. Recording them here so the implementing PR doesn't relitigate.

- **D1. Scope of reassignment = LLM context window only.** The set of messages eligible for reassignment in a given extraction call is exactly the messages already in `ExtractionContext` (`recentMessages` plus the tails of `activeConversations` that the prompt surfaces). The service validates `messageId ∈ candidateSet` and rejects anything else. Rationale: matches what the model can see, costs nothing extra to enumerate, defensive against hallucinated IDs (parallels the existing `validUpdateTargets` set at `boundary-extraction-service.ts:116`).
- **D2. Multi-membership applies to all stream types.** Threads included. `LLMBoundaryExtractor.handleThreadMessage` (`apps/backend/src/features/conversations/boundary-extraction/llm-extractor.ts:69`) loses its deterministic single-conv return path and goes through the LLM. The existing `parentMessageConversations` fetch at `boundary-extraction-service.ts:88` is exactly what feeds the "thread message also belongs to the parent's conv" decision.
- **D3. Single-pass extractor.** One LLM call per new message returns `{ assignments, reassignments, completenessUpdates }`. All writes commit in one transaction. No new worker, no second-pass reclassifier. Late-confirming-shift is handled at _the next message's_ extraction, when the confirming signal is in-context. This matches the existing service shape and the user's "when a new message arrives, fix it then" mental model.
- **D4. Asymmetric assignment with a primary.** Each message has exactly one `primary` conversation (used for chronological listing, sidebar previews, "which conv does this message render in?") and zero-or-more `secondary` conversations (used for retrieval, memory, cross-references). Reassignment changes the _primary_. New-message multi-assignment writes one primary + ≥0 secondaries. Rationale: keeps the existing "open this conv, see its messages in order" UI semantics intact; symmetric all-equal assignment would force every consumer to pick a tiebreaker.
- **D5. Join table, not arrays.** `conversations.message_ids` (and `participant_ids`) get superseded by a `conversation_message_assignments` join table. The array column stays during migration for backwards compat reads, then is dropped. Rationale: primary/secondary is a property of the (conv, message) pair — that lives on the edge, not the vertex.

## Schema Change

New table:

```sql
CREATE TABLE conversation_message_assignments (
  id              TEXT PRIMARY KEY,          -- cma_xxx ULID
  workspace_id    TEXT NOT NULL,             -- INV-8 scoping
  conversation_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  stream_id       TEXT NOT NULL,             -- denorm for stream-scoped reads
  is_primary      BOOLEAN NOT NULL,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason          TEXT,                      -- 'initial' | 'reassigned' | 'secondary' | 'merge'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each message has exactly one primary conv.
CREATE UNIQUE INDEX conversation_message_assignments_message_primary
  ON conversation_message_assignments (message_id)
  WHERE is_primary = TRUE;

-- A (conv, message) pair appears at most once.
CREATE UNIQUE INDEX conversation_message_assignments_conv_message
  ON conversation_message_assignments (conversation_id, message_id);

CREATE INDEX conversation_message_assignments_conv
  ON conversation_message_assignments (conversation_id, assigned_at);

CREATE INDEX conversation_message_assignments_workspace
  ON conversation_message_assignments (workspace_id);
```

Notes:

- Prefixed ULID `cma_xxx` (INV-2). Add to `apps/backend/src/lib/id.ts`.
- No FKs (INV-1). No DB enum on `reason` (INV-3) — TEXT validated in code.
- The unique-primary partial index enforces D4 at the DB level: any reassignment is an "update or replace" of that one row, race-safe via `ON CONFLICT (message_id) WHERE is_primary` on the partial index target.
- Backfill migration: one row per `(conv, message)` from existing `conversations.message_ids`, all with `is_primary = TRUE, reason = 'initial'`. Migration is append-only (INV-17); a follow-up migration in a later PR drops the array columns after read paths cut over.

## Extractor / Service Flow Under New Design

### `ExtractionContext` additions

In `apps/backend/src/features/conversations/boundary-extraction/types.ts`:

```ts
export interface ExtractionContext {
  newMessage: Message
  recentMessages: Message[]
  activeConversations: ConversationSummary[]
  streamType: string
  parentMessageConversations?: ConversationSummary[]
  workspaceId: string
  /** NEW: message IDs eligible for reassignment in this call. */
  reassignmentCandidates: string[]
}
```

`reassignmentCandidates` is the union of `recentMessages[].id` and the message IDs from `activeConversations[*]` that the prompt surfaces. Built by the service in phase 1.

### `ExtractionResult` shape

```ts
export interface MessageAssignment {
  conversationId: string | null // null → new conv created from newConversationTopic
  isPrimary: boolean
}

export interface Reassignment {
  messageId: string // must be in reassignmentCandidates
  toConversationId: string | null // null → reassign into the new conv this call creates
  reason: string // short LLM-provided rationale, stored on the assignment row
}

export interface ExtractionResult {
  assignments: MessageAssignment[] // ≥1, exactly one with isPrimary=true
  newConversationTopic?: string // required if any assignment.conversationId is null
  reassignments?: Reassignment[] // 0+
  completenessUpdates?: CompletenessUpdate[]
  confidence: number
}
```

Note: this is a breaking change to `ExtractionResult`. The existing `conversationId: string | null` single-value field goes away. Stub extractor (`apps/backend/src/features/conversations/boundary-extraction/stub-extractor.ts`) needs to be updated in lockstep; the service consumer is the only call site.

### Prompt changes

In `apps/backend/src/features/conversations/boundary-extraction/config.ts`:

- Output schema (`extractionResponseSchema`) updates to mirror the new `ExtractionResult` shape.
- Prompt body adds two sections:
  - **Multi-membership instructions:** "A message can belong to more than one conversation. If this message clearly continues two ongoing threads, return both. Pick the most-continuous one as primary."
  - **Reassignment instructions:** "If this new message reveals that one or more of the most recent messages was placed in the wrong conversation, move them. You can only move messages from the _Recent Messages_ and _Active Conversations_ sections — never any other. Each move needs a one-line reason."

### Service flow (`boundary-extraction-service.ts`)

Phases stay the same; what each phase does changes:

- **Phase 1 (read, withClient):** unchanged except:
  - Build `reassignmentCandidates` (set of all message IDs surfaced in the prompt).
  - For threads: still fetch `parentMessageConversations`, but no longer treated as a deterministic shortcut — it feeds into `activeConversations` for the LLM to consider.
- **Phase 2 (AI, no conn):** call extractor once. Same as today, returns the richer result.
- **Phase 3 (write, withTransaction):**
  1. Validate `reassignments[].messageId ∈ reassignmentCandidates` and `reassignments[].toConversationId ∈ validUpdateTargets ∪ {newly-created-this-turn}`. Silently drop invalid ones with a `logger.warn` (same pattern as the existing completeness-update validator at `boundary-extraction-service.ts:207`).
  2. If any `assignments[].conversationId === null`, insert one new conversation row (no `messageIds` array — the join-table rows carry that now).
  3. For each `assignment`, insert a `conversation_message_assignments` row. The `is_primary` row uses an upsert against the partial unique index to be race-safe (INV-20):
     ```sql
     INSERT INTO conversation_message_assignments (..., is_primary, ...)
     VALUES (..., TRUE, ...)
     ON CONFLICT (message_id) WHERE is_primary
     DO UPDATE SET conversation_id = EXCLUDED.conversation_id, reason = EXCLUDED.reason;
     ```
     Secondary rows use `ON CONFLICT (conversation_id, message_id) DO NOTHING`.
  4. For each `reassignment`, run the same upsert on the primary partial index — old primary row gets rewritten to point at the new conv. Track `(fromConvId, toConvId, messageId)` for outbox.
  5. Apply `completenessUpdates` as today.
  6. Emit outbox events (see next section).

### Outbox / Frontend Impact

Two new event kinds, plus retention of the existing two:

- `conversation:created` — unchanged.
- `conversation:updated` — unchanged; emitted for every conv whose membership or completeness changed this call (could be 2-3 in a reassignment turn).
- `conversation:message_assigned` — `{ workspaceId, streamId, messageId, conversationId, isPrimary, reason }`. Emitted for each NEW assignment (initial primary + any secondaries on the new message).
- `conversation:message_reassigned` — `{ workspaceId, streamId, messageId, fromConversationId, toConversationId, reason }`. Emitted for each moved message. Only fires for primary-conv changes; secondary additions on prior messages would go through `conversation:message_assigned` instead.

Frontend conv stores (TanStack Query caches) subscribe to these and patch their local `messageIds` arrays on receipt. Per the cache-only observer pattern, the bootstrap fetch for a conv returns its message IDs as a flat array (primary-only by default; secondary memberships exposed via a separate field on `Conversation`). INV-53 holds: socket subscriptions paired with bootstrap, bootstrap invalidated on resubscribe.

## Sub-PR Sequencing

Each step lands independently green. No flag gymnastics — each PR cuts over the relevant slice fully and the next PR builds on it.

### PR-1 — Types and join table, no behavior change

**Scope:** schema + types only. No service or extractor logic touched.

- Add `cma_` prefix to `apps/backend/src/lib/id.ts` and `conversationMessageAssignmentId()` helper.
- Migration: create `conversation_message_assignments`, indexes, backfill from existing `conversations.message_ids` (one row per pair, `is_primary = TRUE`, `reason = 'initial'`).
- New `ConversationMessageAssignmentRepository` in `apps/backend/src/features/conversations/` with the read methods needed for downstream PRs (`findByMessageId`, `findPrimaryByConversation`, `findByConversation` with `includeSecondary` flag).
- Update `packages/types/src/conversation.ts` with new `MessageAssignment` and event payload types. Do not yet wire frontend.
- Unit tests for the repo. No service changes, no extractor changes.

### PR-2 — Service writes to join table alongside the array

**Scope:** dual-write. Reads still come from `conversations.message_ids`. Reassignment not yet implemented.

- `BoundaryExtractionService.processMessage` writes both the existing `conversations.message_ids` array update AND a `conversation_message_assignments` row (`is_primary = TRUE, reason = 'initial'`) in the same transaction.
- No `ExtractionResult` shape change yet — extractor still returns a single `conversationId`.
- E2E test: after a message lands, the join table row exists, primary, matches the array.

### PR-3 — Extractor multi-assignment + reassignment, threads go through LLM

**Scope:** the actual product change. Single PR because the extractor schema, prompt, service consumer, and thread path are tightly coupled.

- Update `ExtractionResult`, `ExtractionContext`, `extractionResponseSchema`, and `BOUNDARY_EXTRACTION_PROMPT` together.
- Update `LLMBoundaryExtractor.extract` to consume the new schema. Delete the `handleThreadMessage` short-circuit; threads pass through the LLM with `parentMessageConversations` surfaced in `activeConversations`. (`handleThreadMessage` becomes the bootstrap path only for the very first thread message, where there are no active convs and no parent conv yet — keep that one tiny fallback.)
- Update stub extractor.
- Service Phase 3 implements assignment loop and reassignment loop with the validators described above. Emit `conversation:message_assigned` and `conversation:message_reassigned` outbox events.
- Backfill audit: after deploy, re-run `scripts/analyze-conversation-boundaries.ts` on a sample of streams and confirm sandwich / premature-resolved counts drop.
- E2E coverage: cross-topic single message → two assignments. Topic-revealed-late case → reassignment of prior message. Thread root continues parent topic → secondary assignment to parent conv.

### PR-4 — Reads cut over, drop arrays

**Scope:** read paths use the join table; `conversations.message_ids` and `participant_ids` go away.

- Replace `ConversationRepository.findByMessageId`, `findByMessageIds`, etc. with join-table-backed equivalents.
- Update the conversation API response shape: `messageIds` becomes primary-only by default with an optional `secondaryMessageIds` field (or surface secondaries via a separate endpoint).
- Frontend: handle the new shape, subscribe to `conversation:message_assigned` and `conversation:message_reassigned`.
- Migration: drop `conversations.message_ids` and `conversations.participant_ids` columns. (Participant set becomes a derived view: distinct authors of messages assigned to the conv.)
- Run the audit script one more time post-deploy to baseline the new world.

## Out of Scope

- **Cross-stream reassignment.** A message stays in its stream's conversation graph. A message in channel A is never reassigned to a conv in channel B.
- **Manual user override.** No UI surface for "move this message to that conversation" yet. Could come later; the schema supports it (just write a row with `reason = 'manual'`).
- **Retroactive batch re-extraction.** This plan only fixes new-message-time misclassification + the K-message window behind it. Old prod data stays as-is unless we explicitly run a one-shot rewriter (out of scope).
- **Merging two existing conversations.** If two adjacent convs should be one, we don't merge them — the next message that bridges them will reassign its predecessors via the normal path, which is sufficient for most cases. A dedicated merge primitive can come later if the audit shows it's still a common residual.

## Invariants Touched

- **INV-1** (no FKs): respected; the join table has no FKs.
- **INV-2** (prefixed ULIDs): new `cma_` prefix.
- **INV-8** (workspace scoping): join table carries `workspace_id`.
- **INV-17** (append-only migrations): PR-1 and PR-4 each add a new migration; nothing edits existing files.
- **INV-20** (race-safe writes): primary-assignment upsert uses partial unique index + `ON CONFLICT`.
- **INV-41** (no conn during AI): unchanged; three-phase pattern preserved.
- **INV-51 / INV-52** (feature colocation, barrel exports): new repo and types live in `features/conversations/`, exported via `index.ts`.
- **INV-53** (socket + bootstrap pairing): new event kinds paired with conv bootstrap invalidation on resubscribe.

## Open Questions

None blocking PR-1. To revisit before PR-3 ships:

1. **Confidence on reassignments.** Should each reassignment carry its own confidence number, or do we just trust the overall call's confidence? Leaning: per-reassignment confidence, stored on the assignment row, used by the audit script to spot low-confidence moves.
2. **Participant denorm.** If we drop `conversations.participant_ids`, do any read paths need an indexed `conversation_participants` view, or is a `SELECT DISTINCT author_id ... JOIN assignments` query fast enough at the scale we expect per conv (<200 messages, usually <10 authors)?
