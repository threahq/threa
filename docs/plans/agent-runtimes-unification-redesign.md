---
title: Agent Runtimes Unification — Audit & Redesign
status: proposal
audience: engineering
created: 2026-06-10
related:
  [
    agent-runtime-pluggability.md,
    audits/e2ee-enclave-audit-2026-06.md,
    features/architecture/agent-runtime.md,
    features/architecture/e2e-enclave.md,
  ]
summary: >
  A re-verified audit (2026-06-10) of the three agent surfaces — the in-process
  companion (Ariadne), the enclave E2EE runtime, and the external bot-runtime
  path — followed by a concrete redesign that unifies them around one Turn
  Contract: companion and enclave become near-identical drivers of the shared
  loop, and the external path becomes the same contract with one declared
  difference (the agent is not ours, so it drives its own model and loop).
---

> **Relationship to prior docs.** `agent-runtime-pluggability.md` (2026-06-05)
> explored five architecture directions and recommended a "Turn Protocol spine +
> TAIP trust/negotiation skin." This document re-verifies its findings against
> the code five days and ~15 PRs later, adds what changed, and turns the
> recommendation into a committed-shape proposal with parity targets and a
> phased migration. Where the two disagree, this document is current.

# Part 1 — Audit (verified against the working tree, 2026-06-10)

## 1.1 The three surfaces

| Surface                                 | Code                                                                          | Who drives the model                                   | Transport                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| **Companion** (Ariadne, plaintext)      | `packages/agent-runtime` + `apps/backend/src/features/agents/`                | Threa, in-process (`AgentRuntime`)                     | direct function calls                                            |
| **Enclave** (Ariadne, E2EE)             | same loop via curated barrel + `apps/enclave/` + `features/enclave-runtimes/` | Threa, in the enclave (`AgentRuntime` over OpenRouter) | sealed HTTP assignment + HTTP callbacks                          |
| **External bot** (Pi, OpenClaw, custom) | `features/bot-runtimes/` + `features/public-api/` bot endpoints               | **The third party** (its own loop, its own model)      | websocket hello/bootstrap + HTTP claim/steps/complete/fail/renew |

## 1.2 What is already unified — more than the June 5 doc credited

1. **The loop is one class.** Companion and enclave both run the same
   `AgentRuntime` (`packages/agent-runtime/src/runtime/agent-runtime.ts:43-94`
   config, loop below it). `enclave-runtime.ts` is a curated re-export barrel
   (no `createAI`, no OTEL), not a fork.
2. **The projection layer is one schema for all three.** This is the key fact
   the prior doc undersold ("it shares none of the loop" — true, but
   incomplete). The bot claim handler inserts into `agent_sessions` with the
   invocation id as the session id
   (`public-api/handlers.ts:929`, `insertRunningOrSkip`), bot `/steps` POSTs
   append to `agent_session_steps` via the same
   `AgentSessionRepository.appendStep` (`handlers.ts:1033`), and all three
   surfaces emit the same `agent_session:started/progress/step:completed/completed`
   socket events. The frontend renders a Pi trace, an enclave trace, and an
   Ariadne trace through one UI with no actor-type branching.
3. **E2E exclusion of external bots is now enforced** (PR #780): the bot
   invocation outbox handler short-circuits E2E streams
   (`bot-runtimes/invocation-outbox-handler.ts:95-97`) and
   `completeBotInvocation` rejects with `assertNotE2eStream`
   (`public-api/handlers.ts:1113`). E2EE-2/11 are fixed.
4. **Tool vocabulary and trust boundary.** `AgentToolName`,
   `TOOL_CATEGORIES_BY_NAME`, `protectToolOutputText` are shared by both
   in-process hosts.

So the unification problem is **not** "three unrelated systems." It is: one
shared loop with two hosts that wire it differently (drift), plus one external
path that shares the _downstream_ projection but none of the _upstream_
contract (trigger semantics, payload, capabilities, lifecycle).

## 1.3 Drift matrix — June 5 findings re-verified today

| Finding   | Claim                                                     | Status 2026-06-10                           | Evidence                                                                                                                                                                                                                                                                              |
| --------- | --------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2EE-9    | Enclave replies drop citation sources                     | **Still true**                              | `apps/enclave/src/agent/run-turn.ts:227` — `sendMessage: async ({ content })` destructures only `content`; `EnclaveSealedReply` has no sources field (`packages/types/src/api.ts:484-488`)                                                                                            |
| E2EE-14   | Enclave trace steps drop `trace.sources`                  | **Still true**                              | `trace-observer.ts:116-126`; `EnclaveSealedStep` has no sources field                                                                                                                                                                                                                 |
| UX-12     | No mid-turn interjection in enclave                       | **Still true**                              | `run-turn.ts:191-244` — config sets no `newMessages`; the loop's whole reconsider path is dead code there                                                                                                                                                                             |
| #4        | `context:received` synthesized out-of-band by the enclave | **Still true**                              | `run-turn.ts:250-252` calls `traceObserver.emitContext(...)` before `runtime.run()`, errors swallowed                                                                                                                                                                                 |
| #5        | Observers diverged on event types                         | **Still true**                              | `SessionTraceObserver` handles 10 kinds incl. `response:kept`/`reconsidering`/`message:edited` (`session-trace-observer.ts:41-215`); `EnclaveTraceObserver` handles 6 (`trace-observer.ts:59-173`)                                                                                    |
| #8        | Per-tool category gate dead on companion                  | **Still true, now asymmetric**              | `isToolAllowedByPolicy` (`tool-privacy.ts:116`) — zero production call sites. But the enclave now enforces a **per-stream** category policy (see §1.4) the companion lacks entirely                                                                                                   |
| #6        | Lifecycle asymmetries                                     | **Still true**                              | Enclave has no `/fail` callback — errors are logged and swallowed (`session-runner.ts:72-78`), sessions die by orphan-cleanup staleness. Bots have `/fail` but unbounded `attempts` and no park/DLQ                                                                                   |
| #9        | Cost/telemetry companion-only                             | **Still true**                              | Enclave config has no `costContext`/`telemetry` (`run-turn.ts:191-244`); usage is summed locally and returned only at `/complete`. Bot turns record nothing                                                                                                                           |
| E2EE-2/11 | Plaintext bot replies into E2E streams                    | **Fixed** (PR #780)                         | see §1.2.3                                                                                                                                                                                                                                                                            |
| UX-7      | Enclave Ariadne can't explain her limits                  | **Fixed** (PR #784)                         | `agents/enclave-system-prompt.ts:77-83`                                                                                                                                                                                                                                               |
| UX-5      | No auto-title for E2E scratchpads                         | **Fixed, enclave-only mechanism** (PR #794) | `run-turn.ts:261-276`, sealed-name callback (`session-handlers.ts:218-244`) — a third naming path now exists                                                                                                                                                                          |
| §5.7      | Pi-isms in the "generic" dispatcher                       | **Still true**                              | ASCII-only mention regex (`invocation-outbox-handler.ts:24-26`), `pi-local` hardcoded in `findActivePiRemoteSession` (`bot-runtimes/service.ts:179`), Pi-only session links (`service.ts:232-282`), hardcoded "Run `/remote-control` in Pi" copy (`invocation-outbox-handler.ts:208`) |

## 1.4 New findings (not in the June 5 docs)

- **N-1: The per-stream tool policy shipped encrypted-first, and the surfaces
  inverted.** Migration `20260530171514_e2e_stream_tool_policy.sql` added
  `allowed_tool_categories` to `e2e_streams`; the dispatch threads it
  (`request-builder.ts:115`) and the enclave enforces it
  (`apps/enclave/src/agent/tools.ts:62`, `isToolCategoryAllowed`). So the
  _encrypted_ surface now has a per-stream tool policy that the _plaintext_
  surface has no equivalent of — plaintext Ariadne's gating is per-persona
  `enabledTools` only. Three gating models remain unreconciled: per-persona
  tool list (companion), per-stream category policy (enclave), trigger-kind
  capabilities (bots — which gate nothing about tools at all).
- **N-2: Auto-title is now a third parallel mechanism.** Plaintext scratchpads
  are titled by the server-side naming outbox handler; E2E scratchpads by an
  enclave post-turn LLM call sealed under the SSK. Bot-driven scratchpads rely
  on the plaintext server path. Three naming paths, one product behavior.
- **N-3: Cancellation is three different channels.** Companion: `shouldAbort`
  polled in-loop + cooperative tool signals. Enclave: a separate
  `POST /sessions/:id/cancel` route on the enclave app, with no in-loop
  `shouldAbort`. Bots: nothing — a cancelled/deleted trigger only surfaces as
  invocation cancellation, with no signal into a claimed run.
- **N-4: The external invocation payload is prompt-only.** A bot receives
  `SerializedBotInvocation` — `promptMarkdown`, ids, trigger, capability — with
  **no conversation history and no handle to fetch it** scoped to the
  invocation (`bot-runtimes/socket-handler.ts:237-268`). A bot that wants
  context must hold broad read scopes and re-fetch via the public API itself.
- **N-5: The completion schema is the floor and nothing else.**
  `completeInvocationSchema` is `finalMessageMarkdown` XOR `noResponse` plus
  flat string metadata (`public-api/schemas.ts:113-124`). No sources, no
  multimodal, no structured result — a bot that researched something cannot
  cite it the way Ariadne does, even though its steps land in the same trace
  tables.
- **N-6: Reply-only bots produce blank traces.** Steps are optional; nothing
  synthesizes a minimal `context:received` + `message:sent` trace for a bot
  that never POSTs `/steps`, so the same activity card that always shows steps
  for Ariadne can be empty for a bot.
- **N-7: The key-distribution half of E2E-for-external-bots already exists.**
  Bot runtimes register a per-session X25519 **BIK** at `bot:hello`
  (`bot-runtimes/socket-handler.ts:40`, `repository.ts:48-52` — "the short id
  used as `recipient_key_id` when wrapping a stream's SSK to this bot");
  `e2e_stream_actors` accepts `kind: "bot"`; and the owner's client already
  mints SSK wraps to every invited bot's live BIKs, pinned by bot id,
  including on key roll (`streams/service.ts:885-913`, tests at
  `service.test.ts:675-695,788-849`). What does **not** exist is the sealed
  wire: invocations are blocked on E2E streams (PR #780), the claim payload
  has no sealed variant, and `/steps`/`/complete` accept plaintext only. The
  June 5 doc's "it has no SSK and cannot seal" is stale — the accurate
  statement is "it can be granted the key, but there is no sealed transport."

## 1.5 Capability matrix — how identical are the three surfaces today?

Legend: ✅ works · ⚠️ partial/divergent mechanism · ❌ absent · ⛔ absent **by
design** (a real physical/trust constraint, not drift).

| Capability                           | Companion                                            | Enclave                                       | External bot                                                                           |
| ------------------------------------ | ---------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Trigger: companion-mode message      | ✅ outbox → `PERSONA_AGENT`                          | ✅ outbox → `ENCLAVE_INVOKE`                  | ⚠️ "active-scratchpad" invocation (separate handler, separate semantics)               |
| Trigger: @mention                    | ✅                                                   | ⛔ mentions ride in ciphertext                | ✅ (plaintext only; ASCII-only regex — INV-54 tension)                                 |
| Trigger: edit/delete supersede-rerun | ✅                                                   | ❌                                            | ❌                                                                                     |
| Conversation history                 | ⚠️ last 20 messages, access-scoped                   | ⚠️ last 30 sealed messages                    | ❌ prompt-only, no scoped fetch handle (N-4)                                           |
| Prior turns' tool results in context | ❌ ephemeral (steps never re-injected)               | ❌ not shipped                                | ❌                                                                                     |
| Threa-provided tools                 | ✅ ~40                                               | ✅ 4 (web ×3, `load_attachment`)              | ⛔ brings its own                                                                      |
| Tool gating                          | ⚠️ per-persona `enabledTools`; categories unenforced | ✅ per-stream `allowedToolCategories`         | ❌ none (capabilities = trigger kinds)                                                 |
| Sources on replies                   | ✅                                                   | ❌ dropped (E2EE-9)                           | ❌ not expressible (N-5)                                                               |
| Mid-turn interjection / reconsider   | ✅                                                   | ❌ (UX-12)                                    | ❌ (and undeclarable)                                                                  |
| Trace steps → `agent_session_steps`  | ✅ via `SessionTraceObserver`                        | ✅ via `EnclaveTraceObserver` (sealed)        | ✅ via `/steps` POSTs (optional → blank traces, N-6)                                   |
| `context:received` lead-in           | ✅ loop-emitted                                      | ⚠️ hand-synthesized pre-run (#4)              | ❌ never                                                                               |
| Failure lifecycle                    | ✅ fail + DLQ hooks                                  | ❌ no `/fail`; dies by staleness (~2 min)     | ⚠️ `/fail` exists; attempts unbounded, no park/DLQ                                     |
| Cancellation                         | ✅ `shouldAbort` + tool signals                      | ⚠️ separate `/cancel` route                   | ❌                                                                                     |
| Cost attribution / telemetry         | ✅ `costContext` + OTEL                              | ❌ usage only at completion, unrecorded       | ❌                                                                                     |
| Auto-title                           | ✅ server naming handler                             | ✅ sealed enclave title (different mechanism) | ⚠️ rides the server path                                                               |
| E2E streams                          | ⛔ excluded (routes to enclave)                      | ✅ the only path                              | ⚠️ invocations blocked (policy, PR #780); BIK + SSK-wrap machinery already built (N-7) |

**Reading the matrix against the product goal:** the companion and enclave
should differ only on the ⛔ rows (workspace tools, mentions-in-ciphertext) —
today they also differ on seven ⚠️/❌ rows that are pure drift. The external
path should differ only on "brings its own model/loop/tools" and "no E2E" —
today it also lacks history access, sources, interjection declaration, a
synthesized trace floor, bounded retries, and cost recording, and it carries
Pi-isms that make "generic third-party harness" aspirational.

**Root cause, unchanged from June 5:** the loop's edges are optional fields
and opaque closures (`sendMessage` may ignore `sources`; `newMessages?` may be
omitted; observers may handle any subset of events), so a host can silently
narrow a responsibility — and the external path is a separate hand-built
contract that nobody maps onto those edges.

## 1.6 The enclave no-memory guarantee — verified

Product claim to verify: _the enclave generates no memories; all of its
outputs are end-to-end encrypted and opaque to the regional backend; only the
enclave (when invited) can access plaintext._ Verified true as of 2026-06-10,
with three honest caveats. Every server-side pipeline that consumes message
content was swept:

| Pipeline                  | E2E behavior                                                                                                                                                          | Evidence                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GAM / memo extraction     | Short-circuits E2E streams entirely — no memos, no conversations rows                                                                                                 | `memos/accumulator-outbox-handler.ts:142-144`                                                                     |
| Search index + embeddings | E2E streams partitioned out pre-query; tsvector/embedding never populated                                                                                             | `search/service.ts:103-115`                                                                                       |
| Auto-naming               | Sealed enclave title only (`name_ciphertext`/`name_envelope`); never plaintext                                                                                        | `enclave-runtimes/session-handlers.ts:218-245`                                                                    |
| Link previews             | Handler short-circuits E2E streams                                                                                                                                    | `link-previews/outbox-handler.ts:105-108`                                                                         |
| Activity feed             | Returns `[]` for E2E (messages, reactions, saved reminders)                                                                                                           | `activity/outbox-handler.ts:142-143,197-198,228-229`                                                              |
| Push notifications        | Generic "Encrypted message" label, no content                                                                                                                         | `push/service.ts:11-12`                                                                                           |
| AI usage / cost logging   | Token counts + model string only; never prompt/response content                                                                                                       | `ai-usage/cost-service.ts:69-82`                                                                                  |
| Message storage           | Plaintext columns are placeholders; ciphertext + envelope canonical                                                                                                   | migration `20260526175633_e2e_streams.sql`                                                                        |
| Write sink (backstop)     | **INV-E1 enforced at `EventService`** since PR #780: plaintext into an E2E stream throws at the sink, sealed edits refused; scheduled messages backstopped            | `messaging/event-service.ts:439,704`, `scheduled-messages/service.ts:651`, sink tests `event-service.test.ts:764` |
| Enclave outputs           | Replies, trace steps, substeps, titles all sealed (`*_ciphertext` + `*_envelope`)                                                                                     | `session-handlers.ts:172-207,276-288,331-356`                                                                     |
| Enclave invitation        | Enclave actor added to `e2e_stream_actors` at E2E creation (idempotent); dispatch requires the invitation **and** live-EIK SSK wraps for current + trigger generation | `e2e-streams/actor-repository.ts:39-53`, `dispatch/request-builder.ts:67-87`                                      |

**The honest caveats (state these wherever the guarantee is marketed):**

1. **Metadata is visible.** Step types, step counts, durations, message ids,
   token counts, model string, and timestamps are cleartext — the backend sees
   the _shape_ of every encrypted turn (Ariadne ran 4 steps, one was a
   `tool_call`, the reply was ~900 completion tokens), never its content.
2. **Plaintext necessarily transits the enclave process and the model
   provider.** The enclave decrypts to run the loop and sends plaintext to
   OpenRouter pinned to zero-retention providers
   (`provider: { data_collection: "deny" }`, `apps/enclave/src/llm.ts:78`).
   That is a contractual guarantee, not a cryptographic one.
3. **"Only the enclave" is operational, not attested** (E2EE-21/22, still
   open): enclave identity rests on `INTERNAL_API_KEY` secrecy and the
   registration path; `/attestation` is informational. Real attestation +
   per-runner identity is Phase 2.4 in the migration plan and is the
   precondition for making this claim adversarially robust.

## 1.7 Conversation continuity — what the agent remembers turn-over-turn

How "session-like" is a scratchpad conversation today? Each trigger message
creates a fresh `agent_sessions` row and a fresh context build — there is no
persistent session object — but continuity is **reconstructed from the
stream** each turn:

- **Companion:** last 20 messages (`MAX_CONTEXT_MESSAGES`,
  `companion/context.ts:135`), access-scoped, with full attachment text for
  the trigger + last 3 user messages and summaries for older ones.
  `lastSeenSequence` is only a dedup guard, never a context source.
- **Enclave:** last 30 sealed messages shipped in the assignment
  (`MAX_HISTORY_MESSAGES`, `enclave-invoke-worker.ts:31`), decrypted
  in-enclave; attachments re-shipped under a 32MB inline budget. The enclave
  is stateless between assignments.
- **External bot:** `promptMarkdown` only — zero history (N-4). The one
  longitudinal concept in the whole system is here, though:
  `bot_runtime_session_links` + `targetRuntimeSessionId` let a harness keep
  its **own** long-running session and have Threa hand back the handle each
  turn. The harness owns the state; Threa passes the key. (Pi-only today.)

So the "every message is a brand-new conversation" worry is half-true: the
**message text** of the conversation carries over (within caps) on the two
first-party surfaces — but three things do not:

1. **Tool work is amnesiac (C-1).** Prior turns' tool calls and results live
   only in `agent_session_steps` (sealed steps for E2E) and are **never
   re-injected** into a later turn's context. If Ariadne researched something
   in turn 1, turn 3 sees only her final reply text — "what did that article
   say?" forces a re-search or invites a hallucination. This is the single
   biggest gap between a Threa scratchpad and a Claude.ai/ChatGPT thread,
   where tool results stay in the conversation.
2. **The window is shallow and cliff-edged (C-2).** 20 (companion) / 30
   (enclave) messages, then silent forgetting — no rolling summary, no
   token-budget window. Long scratchpad conversations lose their beginning
   without any signal.
3. **Every turn re-sends everything, uncached (C-3).** No provider-side
   prompt caching (`cache_control`) anywhere, so the cost of deepening the
   window grows linearly per turn and quadratically per conversation.

# Part 2 — Redesign: one Turn Contract, three drivers

## 2.1 The goal, restated as parity targets

1. **Companion ≡ Enclave.** Plaintext Ariadne and encrypted Ariadne are the
   same agent. Every capability is either present in both or carries a typed,
   user-visible "not supported here because <encryption constraint>" — never a
   silent gap. Permitted differences: tool surface (no workspace access inside
   the enclave), sealing, transport.
2. **External ≈ both.** A third-party harness participates through the same
   contract — same trigger semantics, same trace projection, same lifecycle,
   same commit payload — with exactly one structural difference: **the agent
   is not ours**, so Threa hands it a turn instead of driving the model.
   Sealed material reaches it only through an explicit owner key-grant (the
   BIK path, N-7), which policy keeps switched off today — see §2.6.
   Everything else degrades by _declaration_, not by omission.

## 2.2 The shape

This adopts the prior exploration's recommendation (Turn Protocol spine, trust
tiers from TAIP, `declaredUnsupported` sentinels, per-tool metadata) and
anchors it on what the re-audit showed is already shared: **the projection
layer is the contract's fixed point.** All three surfaces already converge on
`agent_sessions` + `agent_session_steps` + `agent_session:*` events. The
redesign defines everything upstream of that as one vocabulary with three
drivers.

```
                 ┌──────────────────────────────────────────────┐
 trigger ──────▶ │ TurnDispatch                                  │
 (one outbox     │  resolveActor → negotiateCapabilities(manifest,│
  vocabulary)    │  streamPolicy) → mint TurnRequest (delivery)  │
                 └────────────┬─────────────────────────────────┘
                              │ TurnRequest { delivery: "plaintext" | "sealed" | "external" }
            ┌─────────────────┼──────────────────────┐
            ▼                 ▼                      ▼
   InProcessTurnDriver  EnclaveTurnDriver     ExternalTurnDriver
   (runs AgentRuntime)  (runs AgentRuntime    (fronts claim/steps/
                         behind sealed HTTP)   complete/fail/renew)
            │                 │                      │
            └────────── TurnEvents + TurnCommit ─────┘
                              │
                 ┌────────────▼─────────────────────┐
                 │ ONE TraceProjector (event→step)   │  → agent_session_steps
                 │ ONE commit sink (required sources │  → messages (+ sealed
                 │  + multimodal in the payload)     │     variants)
                 │ ONE lifecycle (start/heartbeat/   │  → agent_sessions +
                 │  complete/fail/park)              │     agent_session:* events
                 └──────────────────────────────────┘
```

The five load-bearing pieces:

1. **`TurnCommit` payload with required `sources` and `multimodal`.**
   `sendMessage` / `/complete` / the enclave `/messages` callback all converge
   on one payload type where `sources: SourceItem[]` and
   `multimodal: MultimodalPart[]` are required fields (empty array means
   "none", omission doesn't compile / doesn't validate). For the enclave,
   sources ride **inside the sealed payload** (E2EE-9's design constraint).
   For bots, `/complete` gains optional-on-the-wire but
   normalized-to-required-internally fields.
2. **One `TraceProjector`.** Extract the `AgentEvent → step` state machine
   from `SessionTraceObserver`, inject the sink (plaintext DB+socket sink for
   companion; sealing sink for the enclave; the bot `/steps` handler becomes a
   wire-to-`AgentEvent` normalizer feeding the same projector). The projector
   emits `context:received` itself at turn start — deleting both the enclave's
   out-of-band `emitContext` (#4) and the bot path's blank lead-in (N-6).
   Unhandled-event divergence (#5) becomes impossible because there is one
   handler.
3. **One `CapabilityManifest` + `negotiateCapabilities` chokepoint.** Every
   actor that can take a turn declares
   `{ trust: "first-party-inproc" | "first-party-attested" | "third-party",
output: { reply, trace?, sources?, multimodal?, interjection? },
tools: "threa-managed" | "self", triggers: [...] }`. One function computes
   the effective capability set per turn: it folds the per-stream
   `allowedToolCategories` policy (generalized from `e2e_streams` to all
   streams — closing #8 by giving the dead `isToolAllowedByPolicy` its one
   production call site), and it owns the sealed-delivery rule. That rule is
   deliberately **not** "third-party ⇒ never sealed"; it is **"no live,
   explicitly granted SSK wrap for this actor ⇒ no sealed delivery"** — key
   possession via grant, evaluated in one place. The enclave qualifies because
   its grant is automatic at E2E-stream creation; an external bot qualifies
   only if the owner has invited it as an E2E actor (the N-7 BIK path) **and**
   the `externalSealedDelivery` policy switch is on — which it is not today.
   This consolidates the scattered E2E guards into one declarative gate while
   keeping E2EE-for-external-agents a policy flip, not a redesign (§2.6). The
   existing `supportedCapabilities` on `bot:hello` becomes `manifest.triggers`,
   unchanged on the wire.
4. **`declaredUnsupported(reason)` instead of optional fields.** A driver that
   cannot interject (the enclave today, every bot) passes a sentinel, not
   `undefined`. The sentinel is telemetry-visible and renderable ("Ariadne
   can't see mid-turn messages in encrypted scratchpads"), so UX-12-class
   gaps are loud product decisions instead of silent omissions.
5. **Per-tool `promptBlock` + `categories` on `AgentToolConfig`.** A tool's
   system-prompt prose and privacy categories move onto the tool definition,
   so the companion's and the enclave's toolset/prompt assemblers become one
   data-driven path and a new tool cannot be added to one host and forgotten
   in the other.

## 2.3 What changes per surface

**Companion (`InProcessTurnDriver`).** Mostly renames and edge-typing:
`persona-agent.ts` keeps building context exactly as today but hands the loop
a `TurnSink` instead of raw closures. New behavior: per-stream tool policy is
enforced (it currently isn't, on any plaintext stream).

**Enclave (`EnclaveTurnDriver`).** The same driver class as the companion
conceptually — it runs `AgentRuntime` — with the sealing sink. Closing the
parity gaps:

- `sendMessage` commit carries sources/multimodal sealed in the payload
  (E2EE-9/14): extend `EnclaveSealedReply`/`EnclaveSealedStep` with
  fields-inside-the-ciphertext, never cleartext columns.
- A `/fail` callback (E2EE-25/#6) so errors terminate sessions promptly with
  the same `failSessionWithLifecycle` path the companion uses; orphan-cleanup
  stays as the backstop, not the mechanism.
- Interjection: either implement a sealed `newMessages` provider (the backend
  can push sealed mid-turn messages to the running session — the wraps are
  already there) or pass `declaredUnsupported("encrypted scratchpads")` and
  render it. Either is acceptable; silence is not.
- Cost: the usage totals already returned at `/complete` get recorded through
  the same usage-recording path as companion turns (#9), attributed to the
  workspace/user with `origin: "user"`. OTEL stays out of the enclave (egress
  discipline); recording happens backend-side at completion.

**External (`ExternalTurnDriver`).** The existing five verbs survive
unchanged as the wire; the driver wraps them. Closing the parity gaps:

- `bot:hello` carries the full manifest (today's `supportedCapabilities`
  becomes `triggers`; new `output` block is optional with reply-only default —
  **existing Pi/OpenClaw harnesses keep working untouched**).
- `/complete` accepts `sources` (+ later multimodal); `/steps` frames are
  normalized into `AgentEvent`s and fed to the shared projector; undeclared
  capabilities are rejected loudly at the boundary (INV-11).
- **Synthesized-trace floor:** a reply-only harness gets a projector-generated
  `context:received` + `message:sent` trace, visibly marked as synthesized.
- **Context handle (N-4):** the claim response gains an invocation-scoped way
  to read conversation history (either inline recent history in the
  invocation, or a short-lived `contextRef` the bot can exchange for the
  history it's entitled to), so a useful third-party agent doesn't need broad
  standing read scopes.
- **Bounded lifecycle:** `maxAttempts` + park/DLQ on the claim loop, matching
  the queue discipline every first-party job already has.
- **De-Pi-ify:** mention extraction goes through the existing mention
  _entities_ in `contentJson` rather than an ASCII regex over markdown
  (INV-54/INV-58 — the editor already produces mention nodes); session-link
  behavior and the "missing link" notice move into per-`BotRuntimeKind`
  config.

**Out of scope as shipped behavior — but not foreclosed:** third-party
harnesses in E2E streams are off by **policy**, not by architecture (§2.6
spells out the forward-compatibility rules; the key-grant machinery already
exists, N-7). Genuinely out of scope by design: workspace tools inside the
enclave; Threa-managed tools for self-driven harnesses.

## 2.4 Migration plan

Phases are independently shippable; each closes named findings. Phase 0 has no
new abstractions and is worth doing regardless of appetite for the rest.

**Phase 0 — Parity fixes on existing seams (1 PR each)**

| #   | Change                                                                                                                                                                                 | Closes             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 0.1 | Required-`sources` commit payload; thread sealed sources through `EnclaveSealedReply` + reply rendering                                                                                | E2EE-9             |
| 0.2 | Sealed sources on trace steps (`EnclaveSealedStep`)                                                                                                                                    | E2EE-14            |
| 0.3 | Enclave `/fail` callback wired to `failSessionWithLifecycle`                                                                                                                           | E2EE-25, #6        |
| 0.4 | Record enclave usage at `/complete` through the shared usage-recording path                                                                                                            | #9                 |
| 0.5 | Bound bot claim attempts + park/DLQ                                                                                                                                                    | unbounded-attempts |
| 0.6 | Mention extraction from `contentJson` mention entities                                                                                                                                 | INV-54 Pi-ism      |
| 0.7 | Turn digests: persist an end-of-session "tools called / findings / sources" digest step; inject recent digests into the next context build (sealed via the auto-title pattern for E2E) | C-1                |

**Phase 1 — One projector, one gate**

| #   | Change                                                                                                                                                                     | Closes               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1.1 | Extract `TraceProjector` from `SessionTraceObserver`; reimplement `EnclaveTraceObserver` as projector + sealing sink; normalize bot `/steps` into `AgentEvent`s feeding it | #5, E2EE-14 residue  |
| 1.2 | Projector emits `context:received` at turn start for all three; delete `emitContext`; synthesized-trace floor for reply-only bots                                          | #4, N-6              |
| 1.3 | Per-tool `promptBlock` + `categories` on `AgentToolConfig`; both assemblers become data-driven                                                                             | toolset/prompt drift |
| 1.4 | Generalize `allowed_tool_categories` to all streams; `negotiateCapabilities` enforces it via `isToolAllowedByPolicy` for companion + enclave                               | #8, N-1              |

**Phase 2 — The contract**

| #   | Change                                                                                                                                           | Closes                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 2.1 | `TurnDriver`/`TurnSink`/`TurnRequest(delivery)` types; wrap companion (`InProcessTurnDriver`) — no wire change                                   | structural spine                     |
| 2.2 | `EnclaveTurnDriver` over the existing HTTP callbacks; interjection implemented-or-declared                                                       | UX-12                                |
| 2.3 | `ExternalTurnDriver` wraps claim/complete; `bot:hello` manifest; `/complete` sources; context handle; reject-undeclared at boundary              | N-4, N-5, external parallel universe |
| 2.4 | Trust-tier rule in `negotiateCapabilities` replaces scattered E2E guards; per-runner identity + real attestation before the tier is load-bearing | E2EE-21/22 precondition              |

**Deferred deliberately (INV-36):** a published versioned wire contract
(`taipVersion`) until the first non-Threa harness we don't control ships;
multimodal on `/complete`; per-stream _persona_ routing (`harnessId` binding —
the design admits it, nothing requires it yet).

## 2.5 Conversation continuity: scratchpads as long-running conversations

Product goal: a scratchpad with companion mode on should feel like one
continuous Claude.ai/ChatGPT-style conversation — messages, **and the agent's
tool work**, accumulate as shared memory across turns — on plaintext and E2E
alike. The fix is not a persistent session object (the stateless
turn-per-trigger model is correct and race-safe, INV-20); it is making the
**context window a first-class, shared hydration policy** instead of two
hard-coded caps. This slots into the Turn Contract as the `Hydrate` step of
`TurnDispatch`: one `ContextWindowPolicy` consumed by all drivers.

**C-1 — carry tool work forward.** Two mechanisms, complementary:

- _Turn digests (recommended first)._ At session end the loop already knows
  what it did (`AgentRuntimeResult` + the step list). Persist a compact
  per-session digest — tools called, key findings, sources — as a final step
  row, and include the last N turns' digests in the next context build as
  system-context. For E2E, the digest is sealed like any step and shipped in
  the assignment's history (the enclave holds the SSK wraps to decrypt prior
  generations it can open); the backend never sees it. Cheap, bounded, works
  identically on both first-party surfaces.
- _Selective step replay (later, if digests prove lossy)._ Re-inject the raw
  `tool:complete` trace contents of the last 1–2 turns. Strictly richer,
  strictly more expensive — and for the enclave it competes with the 48MB
  assignment budget (E2EE-23), which is why digests come first.

**C-2 — replace the message-count cliff with a budgeted window + rolling
summary.** One shared policy: fill the window newest-first under a token
budget (the `truncateMessages` machinery already exists at
`packages/agent-runtime/src/runtime/truncation.ts`); when older turns fall
out, fold them into a rolling conversation summary that rides at the top of
the context. Plaintext: the summary is computed backend-side and stored on the
session/stream. E2E: the summary is computed **in-enclave** at turn end,
sealed, and stored as a sealed artifact the next assignment ships back —
exactly the auto-title pattern (PR #794) generalized. The regional backend
never holds a plaintext summary; the no-memory guarantee of §1.6 is preserved
because summary plaintext exists only inside SSK-granted recipients — the
enclave today, any owner-granted sealed actor later (§2.6 rule 3).

**C-3 — prompt caching.** Since every turn re-sends a growing prefix,
enabling provider prompt caching (Anthropic `cache_control` via OpenRouter)
on the stable prefix (system prompt + older history) makes deep windows
affordable and faster. For the enclave this must respect the zero-retention
provider constraint — caching is only enabled where the pinned providers
support it under `data_collection: "deny"`; otherwise skip it. This is a pure
optimization and never a correctness dependency.

**Multiplayer surfaces and episode boundaries.** Continuity needs a key —
"which conversation is this turn part of?" — and the answer differs by surface
shape, not by new machinery:

- _Scratchpads and threads: the episode is the stream._ They are bounded
  conversations by construction, and multi-author already works: the context
  build resolves every participant's name and formats history with attribution
  (`companion/context.ts:144-169,294`), so a multiplayer thread is simply the
  same conversation with more user messages. Digests and the rolling summary
  attach to the stream.
- _Channels: reduce to threads._ A channel @-mention already spawns a thread
  where the persona responds (`mention-invoke-outbox-handler.ts:34-43`);
  top-level channel turns don't exist, so no new rule is needed.
- _DMs (and any flat, unbounded surface): episodes by recency._ A DM is one
  endless stream, so continuity attaches to an episode: if the latest
  completed agent session's `lastSeenSequence` falls within the current
  context window (roughly: an invocation within the last ~20 messages), the
  new invocation **continues** that episode — inject its digest chain, with
  the intervening messages already present in the window filling the gap.
  Otherwise start a fresh episode with no digest carry-over.
  `lastSeenSequence` already exists for exactly this comparison, so the
  boundary check is one query.
- _Within-turn multiplayer_ (several people talking while the agent runs) is
  already the interjection/reconsider path on the companion; the enclave gap
  is UX-12, tracked above.

**Why multiplayer digests are safe by construction — scope is the place, not
the person.** The agent's access scope is computed from the _location_, not
the invoking user (`computeAgentAccessSpec`,
`agents/researcher/access-spec.ts:52-81`): a private channel sees itself plus
public streams; a public channel or public scratchpad sees public streams
only; a DM sees the intersection of what both participants can access; only a
**private scratchpad** — a single-user surface — runs with the invoking
user's full access. So on every multi-member surface the scope is identical
no matter which member triggers the turn, and a digest produced by turn N
contains only material the location itself was entitled to see — safe to
inject into turn N+1 regardless of who invoked it.

The residual wrinkle is **scope drift over time**, not who is asking: a
stream that was public when a digest was written can go private later, and a
DM's intersection shrinks when a participant loses access to a stream. So:

- **Digests carry tool work and stay filterable.** Each digest records the
  source stream ids of the workspace material it contains; injection
  re-filters against the location's _current_ access spec — same cheap check
  as `strip-inaccessible-refs`, on the correct axis. Web-derived content is
  exempt (public).
- **The rolling summary carries conversation only.** A prose summary cannot
  be post-hoc filtered, so it is built exclusively from in-stream messages
  (member-visible by definition), never from tool output. Tool memory rides
  only in the filterable digests.

E2E streams are owner-only by design today at every layer, so none of this
arises there — and a private E2E scratchpad's scope is its owner's, matching
the private-scratchpad rule above.

**External bots.** Continuity is the harness's job (it owns its loop), and
the embryo already exists: generalize `bot_runtime_session_links` /
`targetRuntimeSessionId` from Pi-only to any `BotRuntimeKind` whose manifest
declares persistent sessions, and pair it with the N-4 context handle so a
freshly-started harness can rehydrate. Threa's contract is: stable session
handle in, scoped history access on request — not shipping Threa-side
summaries to third parties.

Sequencing: turn digests are **Phase 0 (0.7)** — they need no new
abstractions (the session has its step list at completion; the sealed variant
reuses the auto-title pattern) and they kill the worst of the tool-work
amnesia immediately. The budgeted window and episode boundaries are Phase
1-adjacent (they live in the shared hydration path the contract introduces);
sealed rolling summaries land with the enclave driver work in Phase 2.2;
session-link/episode generalization for harnesses joins the de-Pi-ification
in Phase 2.3. Digest source-stream ids (the scope-drift re-filter input)
must be recorded from the first digest shipped, even if the re-filter itself
lands later — retrofitting provenance onto old digests is not possible.

## 2.6 Forward-compatibility: E2EE for external agents

Product context, stated plainly: Threa-blindness is the point of E2EE for
agentic chat. A user who won't let Threa see their development lifecycle or
private workflows may be entirely comfortable letting **their own**
self-hosted agent see it — the trust decision belongs to the user, not to
Threa's first-party/third-party distinction. So the design must treat "a
third-party harness participates in an E2E stream" as a **deferred policy
decision**, never as an architectural impossibility. We are not adding it
now; we are refusing to make it a rewrite later.

The asymmetry in what exists (N-7): the **key half is built** — BIK
registration at `bot:hello`, bot actors in `e2e_stream_actors`, owner-minted
SSK wraps pinned by bot id that survive key rolls. The **wire half is not** —
no sealed invocation payload, no sealed `/steps` or `/complete`. Turning the
feature on is therefore: build the sealed wire variants, add the consent UX,
flip one gate. To keep it that way, the unification work must honor five
rules:

1. **Sealed wire types are not enclave-named.** When Phase 0.1/0.2 extend
   `EnclaveSealedReply`/`EnclaveSealedStep` with sources, rename them to
   `SealedReply`/`SealedStep` (the enclave is one producer of a shared sealed
   vocabulary, not its owner). Likewise the assignment shape that carries
   sealed history + wraps is the future sealed claim payload — design
   `EnclaveSessionAssignment`'s successor as `SealedTurnContext` consumed by
   any sealed-capable driver.
2. **`delivery: "sealed"` is a variant any driver may receive**, gated by
   `negotiateCapabilities`' key-grant rule (§2.2.3) — never by `instanceof
EnclaveTurnDriver` checks or per-route `assertNotE2eStream` sprinkles. The
   policy switch (`externalSealedDelivery: off`) lives inside the one gate, so
   flipping it is one line plus the consent UX, and every downstream path
   already type-checks.
3. **Sealed continuity transfers automatically.** Turn digests and rolling
   summaries are sealed under the **stream's SSK** (not an enclave-specific
   key), so any recipient the owner has granted — enclave today, a BIK-bearing
   harness later — can read and extend the same conversation memory. Nothing
   about §2.5 may assume the sealed reader is the enclave.
4. **The no-memory guarantee keys off the stream, not the agent.** Every
   server-side gate in §1.6 branches on `isE2eStream` — none on who produces
   the turn. Keep it that way and the entire §1.6 guarantee applies unchanged
   to a sealed external turn.
5. **Trigger semantics inherit the enclave's constraint, not new ones.**
   Mentions ride in ciphertext, so sealed external invocations are
   active-scratchpad/explicit-trigger only — the same boundary the enclave
   already has. No design may depend on server-side content parsing for E2E
   external dispatch (a client-side mention hint is the eventual answer for
   both first- and third-party sealed actors).

What flipping the switch will require when the day comes (so it's scoped now,
not discovered then): a consent surface ("this bot will be able to read this
encrypted scratchpad" — the grant is the owner's deliberate act, unlike the
automatic enclave wrap); per-runner identity so the grant binds to the bot it
names (the wrap path already pins bot id; the callback auth does not —
E2EE-21/22's fix covers both); sealed claim/`/steps`/`/complete` wire
variants mirroring the enclave callbacks; and BIK generation handling on
key roll/revive (the E2EE-7 class of problems, solved once for all sealed
recipients).

## 2.7 Enclave transport: invert push to pull

Today the enclave is **push-addressed**: each instance registers its own
`instanceUrl` at boot (SSRF-validated), dispatch POSTs the sealed assignment
to the chosen instance (`forwarder.ts`), every session is pinned to its
owning EIK via `server_id` expressly so aborts can be routed back
(`repository.ts:111`), and cancel POSTs to
`<instanceUrl>/sessions/:id/cancel`. This works, but it bakes in two costs:

- **Per-instance addressability.** Horizontal scaling requires every replica
  to have its own routable URL — the one deployment shape load balancers are
  designed to hide. The session→instance pinning state exists precisely to
  compensate.
- **Inbound surface.** The enclave must run an HTTP listener that accepts
  sealed payloads (with the 48MB body cap and its misattribution failure
  mode, E2EE-23), and any future mid-turn interaction (interjection, UX-12)
  would mean _more_ inbound routes racing against turn completion.

The fix is to **invert the flow: the enclave pulls.** Two observations make
pull strictly better here, not just simpler:

1. **Interjection is consumed at loop-iteration boundaries anyway.** The
   companion's `NewMessageAwareness.check()` is already pull-shaped — the
   loop polls it between iterations and before committing a draft. Pushing a
   mid-turn message into the enclave would only buffer it until the next
   boundary; a long-lived bidirectional connection buys complexity, zero
   effective latency. The enclave implements the same port as an outbound
   callback — `GET .../sessions/:id/messages?after=<seq>` returning sealed
   `{ciphertext, envelope}` rows — and **no new key machinery is needed**:
   mid-turn messages are sealed under the stream SSK by the sender's client,
   and the enclave already holds the SSK from the assignment's wraps. The
   poll can piggyback on the heartbeat it already sends every turn. This is
   the UX-12 "implement" option, and it lands on the identical seam the
   plaintext agent uses.
2. **Pulling the turn start converges the enclave onto the claim protocol
   the bot path already proved.** If sealed assignments become claimable work
   items (`FOR UPDATE SKIP LOCKED`, TTL + renew, complete/fail — the exact
   lifecycle bot-runtimes runs in production), then: any replica can claim
   (no addressability, no pinning state, no `instanceUrl` registration or
   SSRF validation), scaling is "run more replicas," and the enclave's
   inbound listener disappears entirely except `/healthz` — a real
   attack-surface reduction for the component whose hardening matters most,
   and one less thing real attestation has to cover. Turn-start latency is
   handled the way bots handle it: a stateless wake-up nudge (any instance
   may react) or a short poll interval; the nudge is an optimization, not a
   dependency. Cancellation and `shouldAbort` collapse into the same channel
   — the heartbeat/poll response carries "cancelled/superseded," feeding the
   loop's existing abort gate — closing the N-3 cancellation divergence at
   the same time.

Under the Turn Contract this means `EnclaveTurnDriver` and
`ExternalTurnDriver` share one transport lifecycle (claim → heartbeat/poll →
complete/fail) and differ only on payload sealing and trust tier — the
deepest version of "the enclave works like the others" available. The
wrap-targeting question (the assignment seals to a _specific_ EIK) is the one
genuine complication: either the claim is keyed so only wrap-capable
instances claim it (claim predicate on `key_id`), or — once a shared-EIK or
re-wrap-on-claim scheme exists — any instance can. Start with the predicate;
it is one `WHERE` clause.

Sequencing: this is Phase 2.2 work (it _is_ the `EnclaveTurnDriver`
transport), but the interjection poll (observation 1) stands alone and could
ship earlier as the UX-12 fix without inverting turn start.

## 2.8 Open questions

1. **Enclave interjection: implement or declare?** Implementing sealed
   mid-turn message push is real work (new callback direction, wrap handling);
   declaring it unsupported is honest and cheap. Recommend: declare in Phase 0
   timeframe, decide on implementation after the contract lands.
2. **Context handle shape for bots (N-4):** inline last-N history in the
   invocation vs. a fetch-back ref. Inline is simpler and matches the
   enclave's assignment shape (30 messages); a ref scales better and keeps
   invocation payloads small. Leaning inline-first.
3. **Where does the generalized stream tool policy live** — widen
   `e2e_streams.allowed_tool_categories`'s pattern to a `stream_policies`
   table vs. a column on `streams`? Tracking-table instinct (INV-57) suggests
   the former; read-path simplicity suggests the latter.
4. **`sources: []` willful defeat** (prior doc's spike #3): add the test that
   a turn whose tool results carried sources commits non-empty sources, so the
   required-field guarantee isn't quietly defeated.
5. **Digest authorship and trust (C-1):** the turn digest is model-generated
   text that future turns treat as ground truth. Does it need the same
   trust-boundary wrap as tool output, and should the trace UI render it so
   users can correct a wrong digest?
6. **Sealed-summary key generations (C-2 × E2EE-7):** a rolling summary
   sealed under generation N must be re-wrapped or rebuilt when the stream
   key rolls, or it becomes the same stranded-data class as parked turns.
   Decide: re-wrap on revive (preferred) or rebuild from scratch on
   generation mismatch.
7. **Where does the budgeted window live for mentions/channels?** Scratchpads
   want deep continuity; a channel mention probably still wants the shallow
   window. The `ContextWindowPolicy` should be per-trigger-kind (deep for
   companion-mode scratchpad turns, shallow for mention turns), not global.
8. **DM episode boundary tuning:** "invocation within the last ~20 messages"
   is a message-count heuristic; a long pause in a quiet DM still reads as the
   same conversation to a human. Decide whether the boundary is count-based,
   time-based, or both (e.g., within the window **or** within 24h), and
   whether the user can explicitly start fresh ("new conversation" affordance,
   like clearing a Claude.ai thread).
