# Feature Doc Inventory

A catalog of what exists in the codebase today, bucketed the way this tree is organized,
so backfill can proceed deliberately instead of ad hoc. Compiled from a code sweep on
2026-06-02: backend feature folders (`apps/backend/src/features/*`), frontend routes and
components, the CLAUDE.md invariants, and the packages and services. Re-swept 2026-06-11:
added rows the first sweep missed (messages-and-timeline, user-status, giphy, onboarding),
reconciled rows whose docs had landed without a checkmark, and recorded which surfaces are
currently in flux (see "In flux right now").

Two rules for using it:

- **One-liners are sweep-level.** Good enough to scope a doc, not verified claims.
  Verification happens when the doc gets written, against the code, the way the pilot
  docs were. (The sweep itself produced at least one wrong claim that the pilot had
  already disproven, so treat unverified rows with suspicion.)
- **A row is done when the doc exists** and its frontmatter status reflects reality.

## Public features

| Doc                                                                            | Covers                                                                                                                                  | Where to look                                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [configurable-sidebar](public/configurable-sidebar.md) ✅ (building)           | Sections, presets, quick links, label sections                                                                                          | done                                                                         |
| scratchpads                                                                    | The solo-first entry point: personal streams, AI companion on/off, auto-naming                                                          | `features/streams`, `docs/core-concepts.md`                                  |
| channels-and-dms                                                               | Channels (public/private), DMs (lazy creation), archive, rename                                                                         | `features/streams`                                                           |
| threads-and-conversations                                                      | Nested threads, breadcrumbs, conversation grouping, thread unreads                                                                      | `components/thread/`, `features/conversations`                               |
| messages-and-timeline                                                          | Message lifecycle: edit/delete, edited indicator, context menu and action drawer, system membership events, unread badges and mark-read | `components/timeline/`, `features/messaging`, `features/system-messages`     |
| message-composer                                                               | Rich text, mentions, emoji, formatting toolbar, fullscreen document mode                                                                | `components/composer/message-composer.tsx`                                   |
| giphy                                                                          | GIF search and picker, GIF previews on messages (may fold into message-composer at writing time)                                        | `features/giphy`, `components/giphy/`                                        |
| voice-dictation                                                                | Recording, live transcript, polished vs raw chunks                                                                                      | `hooks/use-voice-dictation.ts`, `features/voice-transcription`               |
| reactions                                                                      | Emoji reactions, reactor details                                                                                                        | `components/timeline/message-reactions.tsx`                                  |
| message-sharing                                                                | Share a message into another stream, quote replies                                                                                      | `components/share/`, `quote-reply-extension.ts`                              |
| slash-commands                                                                 | Command registry, stream-scoped commands, routing to bots                                                                               | `features/commands`                                                          |
| search                                                                         | Global search with filters, in-stream search, quick switcher                                                                            | `features/search`, `components/quick-switcher/`                              |
| [saved-messages](public/saved-messages.md) ✅                                  | Save for later, done/archived lifecycle, reminders                                                                                      | done                                                                         |
| scheduled-messages                                                             | Compose now, send later; edit and send-now                                                                                              | `features/scheduled-messages`                                                |
| drafts                                                                         | Autosave, stashing, drafts page                                                                                                         | `stores/draft-store.ts`, `pages/drafts.tsx`                                  |
| labels                                                                         | Create/join, color and emoji, assign to streams, public/private                                                                         | `features/labels`, `pages/labels.tsx`                                        |
| memory-explorer                                                                | Browse and search memos, tags, knowledge types, memo embeds in messages                                                                 | `features/memos`, `pages/memory.tsx`                                         |
| activity-feed                                                                  | All/unread/me filters, mark read                                                                                                        | `features/activity`, `pages/activity.tsx`                                    |
| notifications                                                                  | Web push, per-stream notification levels, device-aware suppression                                                                      | `features/push`                                                              |
| attachments-and-files                                                          | Uploads, extraction-backed previews, files page, gallery, per-stream explorer                                                           | `features/attachments`, `pages/files.tsx`                                    |
| link-previews                                                                  | URL preview cards on messages                                                                                                           | `features/link-previews`                                                     |
| [e2e-encrypted-scratchpads](public/e2e-encrypted-scratchpads.md) ✅ (building) | Passphrase setup/unlock, inviting actors, encrypted AI companion via the enclave                                                        | done                                                                         |
| invitations                                                                    | Invite links, claiming, joining a workspace                                                                                             | `features/invitations`, `pages/join.tsx`                                     |
| onboarding-and-workspace-creation                                              | Sign-up flow, user setup, creating and selecting a workspace                                                                            | `pages/user-setup.tsx`, `pages/workspace-select.tsx`, `apps/control-plane/`  |
| multi-account                                                                  | Account switcher, add account, scoped logout                                                                                            | `components/account-switcher/`                                               |
| user-settings                                                                  | Appearance, keyboard shortcuts, notification prefs, date/time, accessibility                                                            | `components/settings/`                                                       |
| user-status                                                                    | Status text/emoji, presets, expiry, notification pausing, work schedule                                                                 | `components/status/`, `features/workspaces` (status fields), `lib/status.ts` |
| workspace-settings                                                             | Members and roles, bots, GitHub/Linear integrations, AI usage dashboard                                                                 | `components/workspace-settings/`, `features/workspace-integrations`          |
| public-api                                                                     | REST API for integrations, user API keys                                                                                                | `features/public-api`, `docs/public-api/openapi.json`                        |
| share-target                                                                   | OS-level share into a workspace (PWA), destination picker                                                                               | `pages/share-target.tsx`                                                     |
| offline                                                                        | Composing offline, queued operations, connection status                                                                                 | `sw.ts`, `sync/operation-queue.ts`                                           |
| [ai-companions](public/ai-companions.md) ✅                                    | Personas, companion mode, mentions, in-timeline activity card, agent traces                                                             | `features/agents`, `docs/core-concepts.md`                                   |

## Concepts

| Doc                                                                   | The guarantee                                                                                       | Invariants          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------- |
| [subscribe-then-bootstrap](concepts/subscribe-then-bootstrap.md) ✅   | Confirm the subscription before fetching the snapshot, then merge                                   | INV-53              |
| streams-all-the-way-down                                              | Everything that sends messages is a stream; threads are streams; visibility inherits from the root  | (domain model)      |
| memos-are-pointers                                                    | GAM stores semantic pointers to source messages, never copies                                       | (domain model)      |
| workspace-is-the-boundary                                             | Workspace is the ownership, query, sharding, and residency boundary                                 | INV-8, INV-50       |
| integrity-in-app-code                                                 | No FKs, prefixed ULIDs, TEXT plus code validation; relational integrity lives in the application    | INV-1, INV-2, INV-3 |
| [race-safe-writes](concepts/race-safe-writes.md) ✅                   | Write paths tolerate concurrent callers; no select-then-update, prefer set-based ops                | INV-20, INV-56      |
| events-and-projections                                                | Append-only `stream_events` is the source of truth; read projections commit in the same transaction | INV-7               |
| [optimistic-then-reconcile](concepts/optimistic-then-reconcile.md) ✅ | Optimistic events land in IDB with temp ids; server events replace them by `clientMessageId`        | (frontend pattern)  |
| idb-is-the-client-source-of-truth                                     | The UI reads IndexedDB via live queries; sync writes IDB, never components directly                 | (frontend pattern)  |
| [content-canonical-form](concepts/content-canonical-form.md) ✅       | `contentJson` is the internal canon; markdown only at the wire; previews strip markdown at render   | INV-58, INV-60      |
| language-by-model                                                     | Semantic decisions about language go through a model, never English-only heuristics                 | INV-54              |
| personas-are-data                                                     | Agents are data-driven personas with declarative tools, not hardcoded implementations               | (domain model)      |

Note: the three domain-model rows (streams, memos, personas) live in `docs/core-concepts.md`
today. Decided: they migrate into `concepts/` (one doc each, normal document-feature runs,
with core-concepts.md as the starting source but verified against code like everything
else). Once all three have landed, core-concepts.md is reduced to a short pointer into
this tree. See Decisions below.

## Architecture

| Doc                                                           | Covers                                                                                               | Where to look                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [outbox-pattern](architecture/outbox-pattern.md) ✅           | Transactional events, dispatcher, gap-safe cursors                                                   | done                                                                                            |
| [sync-engine](architecture/sync-engine.md) ✅                 | Client sync lifecycle, reconnect, IDB reconciliation                                                 | done                                                                                            |
| [coordinated-loading](architecture/coordinated-loading.md) ✅ | First-paint gate: reveal app shell + stream content together (resolved names/avatars) off cached IDB | done                                                                                            |
| job-queue                                                     | PG-backed queue: fair-share scheduling, priorities, DLQ, the job-type catalog                        | `apps/backend/src/lib/queue/`                                                                   |
| ai-wrapper                                                    | `createAI` over the AI SDK and OpenRouter, Langfuse/OTEL telemetry, cost tracking and budgets        | `packages/agent-runtime/src/ai/`                                                                |
| socket-rooms                                                  | Room naming (`ws:*`), cookie auth, user socket registry, connection metrics                          | `apps/backend/src/socket.ts`                                                                    |
| [agent-runtime](architecture/agent-runtime.md) ✅ (drifting)  | Persona sessions, tool execution, traces, per-persona tool enablement and access scope               | doc predates the Turn Contract redesign (PR #817 onward); refresh after the unification settles |
| bot-runtimes                                                  | External bot runtime connections and session links                                                   | `features/bot-runtimes`                                                                         |
| [e2e-enclave](architecture/e2e-enclave.md) ✅ (building)      | SSK wraps, enclave instance keys, HPKE, the sealed AI loop                                           | done                                                                                            |
| push-pipeline                                                 | Subscriptions, device/session suppression logic, outbox-driven delivery                              | `features/push`                                                                                 |
| attachment-pipeline                                           | Per-region S3, extraction (PDF/OCR), thumbnails, video transcoding                                   | `features/attachments`, `lib/storage/`                                                          |
| search-architecture                                           | Hybrid full-text and pgvector search, embedding jobs, access control                                 | `features/search`                                                                               |
| memo-pipeline                                                 | The GAM machinery: boundary extraction, classification, memo accumulation                            | `features/memos` and its outbox handlers                                                        |

## Probably skip, or covered elsewhere

- **Service topology** (control-plane, workspace-router, backoffice, db-read-proxy):
  `docs/system-overview.md` already covers it. Link, don't duplicate.
- **Coding conventions** (DI factories, service-owned transactions, thin handlers,
  append-only migrations): CLAUDE.md and `docs/backend/` own these. A concept doc here
  would just restate them.
- **Solo-first philosophy**: belongs in the scratchpads public doc and CLAUDE.md, not a
  standalone concept.
- **Minor infra** (operation-leases, observability/metrics wiring, emoji data and
  usage tracking, user profile cards, bot channel access grants in `features/api-keys`):
  document inline in whichever doc touches them, or not at all.

## In flux right now

Surfaces under active redesign as of 2026-06-11. Don't backfill these; a doc written
mid-redesign churns with every phase PR. For the ones that already have a doc, the doc
stays (it was accurate when written) but gets a refresh pass once the work settles
rather than per-phase edits.

- **agent-runtime**: the Turn Contract unification (PR #817 design; phases landing in
  #838, #841, #845, #847, #848: TraceProjector, per-stream tool policy via
  `stream_policies`, TurnDriver/TurnSink spine). `architecture/agent-runtime.md` predates
  it and is marked drifting above.
- **e2e scratchpads + enclave**: still `building` and actively changing (e.g. #794
  enclave auto-titles). Both docs exist with `status: building`; refresh when it ships.
- **sync-v2**: client cursor in shadow mode (#832, #833, #846). Parts of
  `architecture/sync-engine.md` will need updating when it leaves shadow mode.
- **conversation overlay**: conversation grouping overlay with user corrections (#842)
  is new; fold into threads-and-conversations once it stabilizes.

## Decisions

1. **`docs/core-concepts.md` migrates** (decided 2026-06-02). The streams, memos/GAM,
   and personas sections each become a `concepts/` doc through normal document-feature
   runs. Whichever run lands the last of the three also reduces core-concepts.md to a
   short pointer into this tree, so external references keep working.
2. **Backfill order: stable surfaces first** (decided 2026-06-11, reversing the earlier
   suggestion to start with surfaces under active change, which produced docs that
   drifted within weeks, e.g. agent-runtime). Prefer rows whose code hasn't moved
   recently and the concepts that prevent recurring bugs; defer everything in
   "In flux right now" until the work settles.

## Open questions

1. **Granularity calls** to make at writing time: split user-settings from
   workspace-settings or merge; whether public-api belongs in `public/` (developer
   audience) or its own bucket; whether giphy folds into message-composer; whether
   messages-and-timeline is one doc or splits (lifecycle vs. unreads).
