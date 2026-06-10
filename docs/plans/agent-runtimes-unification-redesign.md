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

## 1.5 Capability matrix — how identical are the three surfaces today?

Legend: ✅ works · ⚠️ partial/divergent mechanism · ❌ absent · ⛔ absent **by
design** (a real physical/trust constraint, not drift).

| Capability                           | Companion                                            | Enclave                                       | External bot                                                             |
| ------------------------------------ | ---------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| Trigger: companion-mode message      | ✅ outbox → `PERSONA_AGENT`                          | ✅ outbox → `ENCLAVE_INVOKE`                  | ⚠️ "active-scratchpad" invocation (separate handler, separate semantics) |
| Trigger: @mention                    | ✅                                                   | ⛔ mentions ride in ciphertext                | ✅ (plaintext only; ASCII-only regex — INV-54 tension)                   |
| Trigger: edit/delete supersede-rerun | ✅                                                   | ❌                                            | ❌                                                                       |
| Conversation history                 | ✅ full, access-scoped                               | ✅ 30 sealed messages                         | ❌ prompt-only, no scoped fetch handle (N-4)                             |
| Threa-provided tools                 | ✅ ~40                                               | ✅ 4 (web ×3, `load_attachment`)              | ⛔ brings its own                                                        |
| Tool gating                          | ⚠️ per-persona `enabledTools`; categories unenforced | ✅ per-stream `allowedToolCategories`         | ❌ none (capabilities = trigger kinds)                                   |
| Sources on replies                   | ✅                                                   | ❌ dropped (E2EE-9)                           | ❌ not expressible (N-5)                                                 |
| Mid-turn interjection / reconsider   | ✅                                                   | ❌ (UX-12)                                    | ❌ (and undeclarable)                                                    |
| Trace steps → `agent_session_steps`  | ✅ via `SessionTraceObserver`                        | ✅ via `EnclaveTraceObserver` (sealed)        | ✅ via `/steps` POSTs (optional → blank traces, N-6)                     |
| `context:received` lead-in           | ✅ loop-emitted                                      | ⚠️ hand-synthesized pre-run (#4)              | ❌ never                                                                 |
| Failure lifecycle                    | ✅ fail + DLQ hooks                                  | ❌ no `/fail`; dies by staleness (~2 min)     | ⚠️ `/fail` exists; attempts unbounded, no park/DLQ                       |
| Cancellation                         | ✅ `shouldAbort` + tool signals                      | ⚠️ separate `/cancel` route                   | ❌                                                                       |
| Cost attribution / telemetry         | ✅ `costContext` + OTEL                              | ❌ usage only at completion, unrecorded       | ❌                                                                       |
| Auto-title                           | ✅ server naming handler                             | ✅ sealed enclave title (different mechanism) | ⚠️ rides the server path                                                 |
| E2E streams                          | ⛔ excluded (routes to enclave)                      | ✅ the only path                              | ⛔ excluded (correct: no SSK, untrusted code)                            |

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
   is not ours**, so Threa hands it a turn instead of driving the model, and
   it can never receive sealed material. Everything else degrades by
   _declaration_, not by omission.

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
   production call site), and it owns the hard rule
   `trust === "third-party" ⇒ delivery ≠ "sealed"` — consolidating today's
   scattered E2E guards into one declarative gate. The existing
   `supportedCapabilities` on `bot:hello` becomes `manifest.triggers`,
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

**Explicitly out of scope, by design (the ⛔ rows):** third-party harnesses in
E2E streams (no SSK, unattested code — the trust-tier rule makes this one
typed guard, flippable only behind real attestation); workspace tools inside
the enclave; Threa-managed tools for self-driven harnesses.

## 2.4 Migration plan

Phases are independently shippable; each closes named findings. Phase 0 has no
new abstractions and is worth doing regardless of appetite for the rest.

**Phase 0 — Parity fixes on existing seams (1 PR each)**

| #   | Change                                                                                                  | Closes             |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------ |
| 0.1 | Required-`sources` commit payload; thread sealed sources through `EnclaveSealedReply` + reply rendering | E2EE-9             |
| 0.2 | Sealed sources on trace steps (`EnclaveSealedStep`)                                                     | E2EE-14            |
| 0.3 | Enclave `/fail` callback wired to `failSessionWithLifecycle`                                            | E2EE-25, #6        |
| 0.4 | Record enclave usage at `/complete` through the shared usage-recording path                             | #9                 |
| 0.5 | Bound bot claim attempts + park/DLQ                                                                     | unbounded-attempts |
| 0.6 | Mention extraction from `contentJson` mention entities                                                  | INV-54 Pi-ism      |

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

## 2.5 Open questions

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
