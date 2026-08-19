# Aside — a private thinking surface beside any stream

Status: design settled, no code written. Distilled from the ideation session of 2026-08-19
(scratchpad `stream_01M021ZZMAC22NCQQNF4YA2Q0R`). Visual references:

- Consolidated design: https://seer.build/ws_vbyzjvdg6g/b/aside-design-f89f13/
- Surface exploration (five concepts): https://seer.build/ws_vbyzjvdg6g/b/aside-concepts-71199d/
- Final iteration, stream-bound Sidecar: https://seer.build/ws_vbyzjvdg6g/b/aside-sidecar-dc5645/

Replaces Discuss with Ariadne, which is removed as part of v1 (inventory below).

## Problem

Reading a stream and needing to think before you reply has no home. Discuss with Ariadne
(`apps/frontend/src/hooks/use-discuss-with-ariadne.ts`, `apps/frontend/src/lib/ariadne/discuss.ts`)
creates a full private scratchpad with a context bag and navigates you away from what you were
reading. The navigation is half of why it feels clumsy; the other half is that the outcome
(usually a reply you want to send back in the original stream) has no path back. Drafting with
agent help either happens in the real composer, where half-formed thoughts sit where you might
accidentally send them, or in a detached scratchpad with manual copy-paste both ways.

## Concept

An aside is a private, agent-backed stream anchored to a spot in a host stream. You open it
beside what you are reading, discuss with Ariadne, verify facts, and shape drafts. When a draft
is ready, "Send to composer" places it in the host stream's real composer for a final human
pass, and you send from there.

Principles, each a product decision from the session:

1. **Thinking tool, not a prose generator.** There is no "polish my prose" verb anywhere.
   Agent content enters a draft only as an insertable, clearly attributed block. The user's
   words stay the user's words.
2. **Attribution is honest and durable.** An inserted agent block stays attributed to the
   agent even after the user edits inside it ("if I pull it in and touch it up, Ari still
   wrote it"). Attribution marks agent-generated content, not "AI helped me research this";
   research assistance is not disclosed.
3. **Access is fully the creator's, with visible boundaries.** The agent runs on the creator's
   access (scratchpad semantics, full workspace reach). When an answer crosses into content
   another participant cannot see, the agent names the boundary ("Pierre probably hasn't seen
   this, he doesn't have access to #finance-raw") so the user decides what to disclose.
4. **Stream-bound.** An aside belongs to where you are thinking. Unlike calls, it never
   follows you to another stream; navigating away folds it back into its anchor event.
5. **Private, persistent, listable.** Only the creator ever sees an aside or its anchor
   event. Asides are not ephemeral: they can be resumed, and later moved to a different
   anchor.

## Stream model

New stream type `aside` in `STREAM_TYPES` (`packages/types/src/constants.ts`). Self-rooted
with contextual parent pointers:

- `root_stream_id` = its own id. Access resolution (INV-62,
  `apps/backend/src/features/streams/access.ts`) is untouched: the aside grants access through
  its own creator-only membership, exactly like a scratchpad. This is what lets a private
  aside sit "inside" a public channel.
- `parent_stream_id` + `parent_anchor_id` are set but contextual, not access-bearing. Threads
  resolve access through the parent chain; asides never do. Consequences:
  - Moving an aside is a metadata repoint. Nothing about access or content migrates.
  - Losing access to the parent (kicked from the channel) does not kill the aside. The user
    keeps their private notes; context-bag re-resolution fails per ref and the agent loses
    read access to the parent. This mimics personal notes and is correct.
- Archival follows the parent. `write-authority.ts` today blocks writes when the target or
  its root is archived; threads inherit through root. Asides are self-rooted, so the write
  authority check gains one explicit parent lookup: an aside is read-only while its parent
  is archived.
- Scratchpad semantics inherited: companion on, GAM memory off (no memo extraction from
  asides), same tool policy, context bag support.
- Thread semantics borrowed: anchored to a parent message, panel-adjacent rendering, listed
  under the parent. Unlike threads, not idempotent per anchor: multiple asides may share an
  anchor, and an aside may exist without one (anchored to the stream itself).

Non-thread ancestry matters in existing code that special-cases `thread`: sweep for
`type === "thread"` / `parent_stream_id` consumers and confirm each treats `aside` correctly
(most should treat it as a root stream and never see it in feeds, search defaults, or
sidebars unless the viewer is the creator, which membership already guarantees).

## Anchor event

Each aside renders as a private inline row in the host stream's timeline at its anchor point.
This row is the discovery, resume, and state surface.

- **Event mechanics:** an author-scoped command-style event, following the existing pattern:
  a real `stream_events` row filtered to the actor in repo SQL plus `isOwnCommandEvent` on
  the client. It takes no `broadcastSequence` slot, so timeline contiguity (INV-61) is
  untouched; to every other viewer the row does not exist.
- **Rendering (decided):** a hairline gold rule across the timeline with plain text riding
  on it, no pill, no tab, no card. Text carries title and state, e.g.
  `churn number sanity-check · draft unsent · 9m`. Hover reveals the resume affordance.
- **States:** active (aside currently open), draft unsent, quiet.
- **Attention (decided: silent).** Returning to a stream with an unsent aside draft pushes
  nothing: no sidebar badge, no toast, no push. The anchor row's state text is the whole
  signal. Aside agent replies follow the same rule; the aside is a pull surface.

## Surfaces (desktop)

Two surfaces plus a minimized state, calls-inspired but stream-bound:

- **Dock:** right-edge panel (~400px) pushing the stream content, chat on top, draft dock at
  the bottom. The floating PiP square from the calls model is cut from v1; stream-binding
  removed its reason to exist.
- **Fullscreen:** host stream read-only on the left, aside chat + draft editor on the right.
  This absorbs the "Study" concept as the aside's fullscreen surface, the same way calls'
  fullscreen works.
- **Minimized:** a slim strip above the composer, not a global pill.
- **Right-edge contention:** calls own the right edge. If a call is docked, the aside
  minimizes to the composer strip instead of docking.
- **Navigate away:** the dock folds toward its anchor, the anchor row briefly indicates it
  received the aside, and the next stream is completely clean. Re-opening the host stream
  restores nothing automatically; the anchor row shows state.
- **Resume:** clicking the anchor row reopens the aside in its last surface.

Mobile is deliberately unexplored; it gets its own design pass after desktop ships or is
validated. The dock likely becomes a bottom drawer, but nothing is decided.

## Entry points

- Slash command in the host composer (replacing `/discuss`; final name with the command, in
  `apps/backend/src/features/commands/catalog.ts`).
- Command palette action.
- Message action ("Open an aside here") setting `parent_anchor_id` to that message.

## What the agent sees

- **Viewport snapshot at open:** the visible message ids plus their surrounding context
  (parent conversations, sibling timeline messages), captured once when the aside opens.
  The read-frontier machinery (`apps/frontend/src/hooks/use-last-seen-event.ts`) already
  computes visible rows, and `apps/frontend/src/lib/preview-visibility.ts` already ships
  visibility frames to the backend; the snapshot reuses that shape.
- Delivered as a context-bag intent (a sibling of
  `apps/backend/src/features/agents/context-bag/intents/discuss-thread.ts`), resolved
  against the creator's access.
- The agent pulls further context itself with its normal tools, on the creator's access,
  naming access boundaries per principle 3.
- Later (v1.x): explicit pull-in gestures, e.g. drag a message onto the dock.

## Drafts

- Multiple living drafts per aside, reusing the `drafts` backend
  (`apps/backend/src/features/drafts/`): scoped rows, integer-version CAS, `context_refs`.
  A draft dock in the aside lists them.
- **Send to composer** is the only exit: the draft lands in the host stream's real composer,
  agent blocks intact, and the user sends from there. The forced final read in real context
  is a deliberate anti-slop mechanism. There is no direct send from the aside.
- Draft rows are shaped to grow into stream-owned editable documents (the v2 document-editor
  ambition) without re-architecture; retargeting a draft to a different stream is a
  follow-up.

## Agent-attributed block

A new ProseMirror node marking agent-generated content inside a user draft/message.

- Template: the quote-reply node (`apps/frontend/src/components/editor/quote-reply-extension.ts`,
  `quote-reply-view.tsx`), with agent-obvious styling in the existing design language (gold).
- Registration points as for any custom node: editor extension, markdown serialize/parse via
  the pointer-URL scheme in `packages/prosemirror/src/markdown.ts`, zod union in
  `packages/types/src/prosemirror.ts`, render component.
- Attribution survives edits: the block boundary and its agent attribution persist through
  user modifications inside it (decided; no detach-on-edit).
- Recipients see the attribution on the sent message. Structured provenance can ride
  `messages.metadata` under the reserved `threa.` namespace
  (`apps/backend/src/features/messaging/metadata-schema.ts`).
- Insertion is the only path agent content takes into a draft: an "Insert into draft" action
  on agent chat messages in the aside.

## Discovery

Anchor rows in the timeline plus the "In this stream" context surface. No header count
(decided against). The context surface gains what it needs anyway per
`docs/plans/in-this-stream-backend.md`: aside items are creator-private entries, so the
projection/query path must support viewer-scoped rows; threads-and-asides scoping comes with
the same change.

## Removal of Discuss with Ariadne

Kill, do not deprecate (INV-38, INV-49):

- `apps/frontend/src/hooks/use-discuss-with-ariadne.ts`, `apps/frontend/src/lib/ariadne/discuss.ts`
  and their call sites.
- The `/discuss` command in `apps/backend/src/features/commands/catalog.ts` / `availability.ts`.
- The discuss-specific create path in `apps/backend/src/features/streams/handlers.ts`
  (contextBag refinements, `ARIADNE_PERSONA_MISSING`) where not reused by aside creation.
- `context-bag/intents/discuss-thread.ts` once the aside intent replaces it.
- Existing discuss scratchpads remain plain scratchpads; no data migration.

## Phasing

**v1:** stream type + anchor event + dock/fullscreen surfaces + viewport-snapshot context
intent + chat with Ariadne + one-or-more drafts with send-to-composer + agent-attributed
block + Discuss with Ariadne removal.

**v1.x:** opt-in reference sweep (ask for a pass that proposes sources backing the draft's
claims; no per-claim superscripts yet), move an aside to a new anchor, drag-in context,
draft retargeting.

**v2:** the document editor: stream-owned, editable, Notion-like documents (useful for
plain scratchpads too), per-claim source annotations, mobile surface, possibly a
memory-on setting per aside.

## Open questions

- Mobile surface design (deferred by decision, not oversight).
- Final user-facing verb/command name for opening an aside.
