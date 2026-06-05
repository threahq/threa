---
title: Agent Runtime Pluggability — Design Deep-Dive
status: exploration
audience: engineering
created: 2026-06-05
related: [audits/e2ee-enclave-audit-2026-06.md, audits/agent-host-parity-2026-06.md]
summary: >
  Five distinct architecture directions for making the companion, the enclave,
  and a marketplace of external third-party agent harnesses (OpenClaw / external
  Pi / ChatGPT / arbitrary) share as much as possible and stop drifting — plus a
  grafted recommendation, a first-class third-party-plugin contract, and an
  incremental 8-step migration. This is an EXPLORATION, not an approved decision.
---

> **Status: design exploration.** This document presents options and a
> recommendation for discussion; nothing here is committed. It is grounded in the
> code as of the cited commit and pairs with the E2EE/enclave audit
> (`docs/audits/e2ee-enclave-audit-2026-06.md`), whose drift findings (E2EE-_,
> UX-_) motivate it. Produced via a multi-agent design workflow (6 current-state
> readers → 5 independent proposals → 3-lens judge panel → synthesis); every
> `file:line` was spot-verified against the working tree.

> **Verified 2026-06-05** against branch `improve-e2ee` (even with main @ `39df1ffa`)
> by adversarial re-check (run `wf_ab425350-0b1`; durable summary in
> `docs/audits/agent-host-parity-2026-06.md`). All substantive claims hold, with
> four corrections that change §6:
>
> 1. Step 1's "(partly built on this branch)" is **wrong** — the merged attachments
>    work is inbound multimodal; Steps 1–5 are 0% built.
> 2. Step 1 must NOT add `sources` to `EnclaveSealedReply` (cleartext wire field —
>    violates E2EE-9's own constraint). Sources extend `E2eSealedPayload` in
>    `@threa/crypto` and ride inside the ciphertext; the frontend decrypt path
>    (`message-envelope.ts` → `parseSealedPayload`) is the consumer half.
> 3. Step 1's "required `multimodal`" is speculative (INV-36): no outbound
>    multimodal-on-commit exists in any host. Dropped.
> 4. The enclave observer divergence list gains a 4th member: it also drops
>    `context:received` via the event path (out-of-band `emitContext` synthesis,
>    `run-turn.ts:236-238`); the shared mapper must own it so Step 4 folds in.
>
> Revised spine order: **2a (extract TraceMapper + exhaustiveness, no format
> change) → 1 (sources in sealed payload) → 2b (steps reuse the format) → 3**.
> Step 3 caveat: the companion gate activation is a no-op until a companion-side
> `allowedToolCategories` policy source is plumbed.

# Agent-Runtime Redesign: Five Distinct Directions for Pluggable Runtimes (incl. First-Class 3P Plugins)

A design deep-dive for the product owner. Goal: make the **companion**, the **enclave**, and a **marketplace of external third-party harnesses** (OpenClaw / external Pi / ChatGPT / arbitrary) look as uniform as possible to Threa — sharing everything that _can_ be shared, degrading cleanly for what cannot, and eliminating the _ability_ to drift rather than just patching the drift we have.

All `file:line` citations were verified against the working tree on branch `e2e-enclave-attachments`.

---

## 1. Current state in one page

### What is genuinely shared (the one true core)

`class AgentRuntime` (`packages/agent-runtime/src/runtime/agent-runtime.ts:157`, loop at `:213`) is host-agnostic and imports **zero host modules**. It is driven entirely by `AgentRuntimeConfig` (`agent-runtime.ts:43-94`), which carries `ai`, `model`/`modelString`, `systemPrompt`, `messages`, `tools`, `observers`, `telemetry`, `costContext`, and the callbacks `sendMessage`, `newMessages?`, `shouldAbort?`, `toolSignalProvider?`, `allowNoMessageOutput?`, `validateFinalResponse?`. The loop owns iteration cap, abort gate, prompt + retrieved-context assembly, message truncation, the model call, tool ordering, source dedup (`mergeSourceItems`), `systemContext` folding, multimodal-image injection, the trust-boundary wrap, the reconsider/interjection state machine, the "never end with zero messages" fallback, and the full `AgentEvent` emission.

`enclave-runtime.ts` is **not a second runtime** — it is a curated re-export barrel of the _same_ `AgentRuntime` with a deliberately minimal dependency surface (no `createAI`/OTEL pull), verified at `enclave-runtime.ts:1-16` (header: "the enclave runs the same loop next to decrypted plaintext, so it must keep its dependency (and egress) surface minimal"). So **for the companion and enclave, the loop is ~100% shared**; they differ only in which barrel they import and what config they hand it.

Also shared: `AgentTool`/`defineAgentTool`/`AgentToolResult`, the `AgentObserver` interface, the web/research tool primitives (used by both companion and enclave), `OtelObserver`, the `TOOL_CATEGORIES_BY_NAME` privacy vocabulary, and `failSessionWithLifecycle`.

### What is duplicated (parallel-but-faithful, by host)

- **Two trace observers.** `SessionTraceObserver` (DB+socket) and `EnclaveTraceObserver` (`apps/enclave/src/agent/trace-observer.ts:59-247`, seal+POST) are hand-mirrored copies of the same `AgentEvent`→step state machine. The enclave file's header says it "mirrors the backend SessionTraceObserver's event→step lifecycle exactly — only the sink differs." They have already diverged on which event types they handle.
- **Two toolset assemblers.** `buildToolSet` (companion, ~40 tools) and `buildEnclaveTools` (enclave, web-only) share no spine; a new shared tool must be added to both.
- **Per-tool system-prompt prose** lives in a host-side prompt builder, not on the tool.

### What is divergent — the parallel universe

The **external-bot** path (`apps/backend/src/features/bot-runtimes/**` + `apps/backend/src/features/public-api/bot-*`) does **not use `AgentRuntime` at all**. It implements a five-verb protocol: `bot:hello` (+`supportedCapabilities`, `socket-handler.ts:132`) → bootstrap → `claim` (FOR UPDATE SKIP LOCKED) → optional `/steps` → `complete` (`finalMessageMarkdown` | `noResponse`, `schemas.ts:117-123`) | `fail`, with `renew`. It receives a `SerializedBotInvocation` (prompt + ids + trigger + `requiredCapability`) — **no history, no tools, no system prompt, no model** — and runs its own loop. `BOT_RUNTIME_KINDS = ["pi-local","hermes","openclaw","claude-code-channel","custom"]` (`constants.ts:710`) already names the intended marketplace. **It shares none of the loop.**

### Concrete drift symptoms (verified)

| #       | Symptom                                        | Evidence                                                                                                                                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2EE-9  | Enclave drops citation sources on replies      | `sendMessage: async ({ content }) =>` destructures only `content` (`run-turn.ts:203`); `AgentRuntimeConfig.sendMessage` allows `sources?` to be omitted (`agent-runtime.ts:64-67`). The shared loop threads sources to the commit; the enclave silently discards them.                                                                                |
| E2EE-14 | Enclave trace steps also drop sources          | `EnclaveTraceObserver` seals step content but never `trace.sources`.                                                                                                                                                                                                                                                                                  |
| UX-12   | Mid-turn interjection missing in enclave       | Companion wires a full `newMessages` provider; the enclave omits `newMessages` entirely (`run-turn.ts` config has no such field). Silent because `newMessages?` is optional (`agent-runtime.ts:71`). The loop's whole reconsider path is dead code in the enclave.                                                                                    |
| #4      | `CONTEXT_RECEIVED` synthesized two ways        | Companion builds it inline; enclave re-synthesizes out-of-band via `traceObserver.emitContext(...)` before `runtime.run()` (`run-turn.ts:221-227`). Every host must remember to do this.                                                                                                                                                              |
| #5      | Observers diverged on event types              | `SessionTraceObserver` handles `response:kept`/`reconsidering`/`message:edited`; `EnclaveTraceObserver` handles none. New event types degrade silently in the enclave.                                                                                                                                                                                |
| #8      | Category privacy gate is **dead on companion** | `isToolAllowedByPolicy` (`tool-privacy.ts:116`) has only test call-sites + the barrel re-export (`index.ts:337`) — **zero production call-sites** (verified by grep). Companion's `allowedToolCategories` is never enforced. Three unreconciled gating models exist (companion `enabledTools`, enclave categories, external `supportedCapabilities`). |
| #6      | Lifecycle asymmetries                          | Enclave has no `/fail` route; three different lifecycle machines.                                                                                                                                                                                                                                                                                     |
| #9      | Cost/telemetry excludes enclave + external     | Only companion records `costContext`.                                                                                                                                                                                                                                                                                                                 |

**Root cause** (one sentence): the loop's _edges_ are untyped opaque closures or `?optional` fields, so a host can omit or narrow a responsibility and the compiler stays silent — and the external path is a wholly separate contract nobody maps to the loop.

---

## 2. The five options, kept distinct

The five share one inevitable common spine (every proposal independently converges on it, which is itself a strong signal it's the right first move):

> **Shared spine** — make the terminal commit payload carry **required** `sources`+`multimodal`; collapse the two trace observers into one `AgentEvent→step` mapper with only the persist sink injected; route all tool gating through one path that revives the dead `isToolAllowedByPolicy`.

Where they differ is the **wrapper** around that spine, and — decisively — **how the external (self-driven) host fits**, since a 3P harness can never consume `AgentRuntimeConfig` (it runs its own model and loop; there is no `generateTextWithTools` for Threa to drive).

---

### Option A — The Ariadne Hexagon (Ports & Adapters)

**Philosophy.** `AgentRuntime` is a pure hexagonal domain core depending only on a small set of **named, total, typed ports**. Each host is a bundle of adapters; the only host-specific code that survives is the adapter fulfilling a port that genuinely cannot be shared (egress, sealing, persistence).

**Shape.**

```ts
// Driven ports (runtime calls out)
interface MessageSink { commit(p: CommitPayload): Promise<{ messageId: string; operation: "created" | "edited" }> }
interface CommitPayload { content: string; sources: SourceItem[]; multimodal: MultimodalBlock[]; replacesMessageId?: string }
interface StepSink { open(id, i): Promise<void>; finalize(id, i: StepIntent): Promise<void>; substep(...): Promise<void> }
class    TraceMapper implements AgentObserver { constructor(sink: StepSink) }  // ONE impl, sink injected
interface InterjectionSource { readonly supported: boolean; check(...): Promise<NewMessageInfo[]>; ... }
interface AbortSource { fatalReason(): Promise<string|null>; toolSignal(...): AbortSignal|undefined }
interface Toolset { resolve(policy: ToolPrivacyPolicy): AgentTool[]; readonly declaredCapabilities: AgentCapability[] }
interface ModelPort { readonly modelString: string; generateTextWithTools: AI["generateTextWithTools"] }
interface HostAdapters { messages; trace; interjection; abort; toolset; model }
// Driving port (something runs a turn)
interface TurnDispatch { dispatch(req: TurnRequest, host: HostAdapters): Promise<AgentRuntimeResult> }
// new AgentRuntime(core: CoreConfig, ports: HostAdapters)
```

**Host plug-in.** Companion = `CompanionHost` bundle (plaintext `MessageSink`, socket `StepSink`, full `Toolset`, backend `AI`). Enclave = `EnclaveHost` bundle imported **only as port interfaces** from the curated barrel (seal-and-POST `MessageSink` now receiving `{content, sources, multimodal}`; the same shared `TraceMapper` with a sealing `StepSink`; web-only `Toolset`; OpenRouter `ModelPort`). External harness = **not** an `AgentRuntime`; a peer behind the `TurnDispatch` _driving_ port — the existing bot-runtimes claim/complete protocol promoted to the canonical external contract.

**Shared / per-host.** Shared: the single `TraceMapper`, the port interfaces, the capability vocabulary, the one gating path. Per-host (legitimately): egress shape (enclave `ModelPort` = one OpenRouter connection), sealing bytes (inside the enclave's `MessageSink`/`StepSink`), persistence backend, tool deps, trust identity.

**Drift killed, how.** E2EE-9/14 → `CommitPayload.sources` is non-optional, so the enclave adapter cannot compile while dropping it. UX-12 → `InterjectionSource` is a _required_ port; a host that can't interject passes `declaredUnsupported(reason)` — loud, not absent. Dead gate → the `Toolset.resolve(policy)` port runs the one gate for all hosts. #4 → `context:received` emitted by the loop's dispatch entry.

**External-agent story.** A 3P harness sits behind `TurnDispatch` as a peer, speaking the bot-runtimes protocol, emitting into the same `CommitPayload`/`AgentEvent` vocabulary via HTTP, declaring `outputCapabilities` at `bot:hello`. **Weakness:** the in-loop ports and the external contract are two _different shapes_ — the bulk of the design (6–7 driven ports) does not apply to the external tier; external uniformity is asserted, not structural.

**Complexity delta.** ~7 port interfaces added; one `TraceMapper` replaces two observers; one gate replaces three. Abstraction _count_ roughly flat, abstraction _quality_ sharply up. Honest read: this finishes the seam the codebase was already reaching for.

**Risks.** Over-abstraction — 7 ports where 3 carry real divergence (`AbortSource`/`ModelPort`/`InterjectionSource` may be ceremony). Changes the `AgentRuntime` constructor signature (wider blast radius into the live loop's entry than wrap-based options). External is a relabel, not a fit.

---

### Option B — Capability Kernel (the Threa Agent Substrate)

**Philosophy.** A turn is a tiny host-agnostic kernel orchestrating a **registered bundle of named capability modules**, discriminated by a closed `CapabilityKind` vocabulary. Forgetting a capability is a _compile error_ (required) or a _declared-disabled_ value (optional) — never a silent gap.

**Shape.**

```ts
type CapabilityKind = "transport"|"commit"|"trace"|"toolset"|"model"|"interjection"|"gating"|"cost"
interface Capability<K extends CapabilityKind> { readonly kind: K }
interface CommitCapability extends Capability<"commit"> { commit(p: CommitPayload): Promise<...> }  // sources/mm required
interface TraceCapability  extends Capability<"trace">  { handle(e: AgentEvent): Promise<void> }
interface GatingCapability extends Capability<"gating"> { admit(toolName): boolean; reason(toolName): string }
type DeclaredDisabled<K> = { kind: K; declaredDisabled: string }
type CapabilitySet = { [K in CapabilityKind]: Extract<Capability<K>,{kind:K}> | DeclaredDisabled<K> }
class Kernel { static compose(bundle, req): ResolvedSet /* THROWS on missing required */; run(set, req): Promise<...> }
```

**Host plug-in.** Companion/enclave each register a `CapabilityBundle`; the kernel runs the existing loop but dispatches each side-effect to the module that owns it. External = the **external tier** — it does _not_ compose a `CapabilitySet` (it runs its own loop); a backend-side `ExternalHostAdapter` implements `CommitCapability`+`TraceCapability` translating the bot wire protocol ↔ the kernel's vocabulary.

**Drift killed.** Same forcing functions as A, plus the strongest _fail-loud-at-registration_ mechanism: `compose()` throws if a required kind is missing, surfacing UX-12 at startup. `DeclaredDisabled<K>` makes "I can't interject and here's why" a first-class telemetry-visible value.

**External-agent story.** `supportedCapabilities` (trigger-timing) extended with an output manifest `{reply, streaming?, trace?, sources?, multimodal?, toolUse?, interjection?}`. **Weakness — self-admitted:** for the two in-loop hosts that exist today the 8-kind registry is "pure tax" until a third in-loop host arrives; external participates only via a separate adapter, so the central abstraction earns nothing for the hardest case. And `CommitPayload.sources` being required can still be _willfully_ defeated by `commit({...p, sources:[]})` — a type can't stop that, so it leans on review.

**Complexity delta.** Most scaffolding of the five (`CapabilityKind` enum + `Capability<K>` + mapped-type `CapabilitySet` + `DeclaredDisabled` + `Bundle` + `Kernel.compose`). Net for the two real hosts: roughly flat. The most type-machinery-heavy construct in the set.

**Risks.** Heaviest ceremony; brushes INV-36 (speculative abstraction justified by a future that may not arrive). Most honest proposal about its own limits — which is a point in its favor for "don't make it worse," but a point against adopting it now.

---

### Option C — The Turn Pipeline (named, ordered, swappable stages)

**Philosophy.** A turn is a **fixed, ordered pipeline of named stages**, each with exactly one canonical default in `@threa/agent-runtime`. A host diverges only by passing a typed override, so drift requires a _visible, type-checked act of opting out_.

**Shape.**

```ts
// Stages, in order: Hydrate → AssembleContext → SelectTools → RunLoop → OnStep → Commit → Finalize
interface HydrateStage        { hydrate(ctx): Promise<{ messages: ModelMessage[]; promptText: string }> }
interface AssembleContextStage{ assemble(ctx, tools): Promise<{ systemPrompt; retrievedContext? }> }  // folds tool.promptBlock
interface SelectToolsStage    { select(ctx): Promise<AgentTool[]> }   // default = gateTools(all, ctx.policy)
interface RunLoopStage        { run(cfg, sink: StepSink, commit: CommitAdapter): Promise<AgentRuntimeResult> }  // default = AgentRuntime; ExternalDispatchLoop = 3P variant
interface CommitAdapter       { commit(input: { content; sources?; multimodal? }): Promise<{ messageId; operation? }> }
interface StepSink            { startStep(s); persistStep(s: MappedStep): Promise<void> }
interface FinalizeStage       { onSuccess(r); onFail(e); onPark(reason): Promise<void> }
interface TurnContext         { ...; sealing: "plaintext" | "sealed"; capabilities: OutputCapabilitySet }
function runTurn(ctx: TurnContext, overrides: Partial<StageMap>): Promise<TurnResult>
// AgentToolConfig gains: promptBlock?: string; categories: ToolPrivacyCategory[]
```

**Host plug-in.** Companion/enclave override `Hydrate`/`Commit` and the `OnStep`/`Finalize` sinks; everything else is the default. The live loop becomes the `RunLoop` default **verbatim** (no rewrite). External plugs in via the `ExternalDispatchLoop` variant of `RunLoop` — `Hydrate`+`AssembleContext` still run on Threa's side, the bot's posted `/steps` and final message are normalized into `AgentEvent`/`CommitInput` and flow through the _same_ `OnStep`/`Commit` path.

**Drift killed.** Same spine. Plus the best treatment of the toolset/prompt-builder drift: per-tool `promptBlock` + `categories` move **onto the tool**, so a new tool can't be added to one host's prompt and forgotten in the other's. `sealing` marker routes sealed turns only to a sealing-capable `Commit`.

**Complexity delta.** Names existing assembly structure (stages map 1:1 to steps already in `persona-agent.ts`/`run-turn.ts`). Deletes two big duplicated blocks, adds small interfaces. Best net-complexity story.

**Risks.** The `RunLoopStage` interface must be "wide enough to admit both a synchronous in-process loop and an async out-of-process dispatch" — that width is where a leaky abstraction breeds drift _inside_ a stage. A fixed ordered pipeline is an _in-process-host shape_; the self-driven external host runs the back half on the harness side, so the "ordered stages" framing fractures across the trust boundary. Pre-building the prompt for a self-driven harness mildly fights "it fetches its own context."

---

### Option D — The Turn Protocol (one verb, two tiers)

**Philosophy.** Stop treating "drive the loop" as the contract. Treat **"produce a turn"** as the contract. Every host implements `TurnRunner`: a request in, a stream of typed `TurnEvent`s out, a typed result back. `AgentRuntime` becomes the _reference in-process implementation_ of that contract, not the contract itself.

**Shape.**

```ts
interface TurnRunner  { readonly capabilities: Capabilities; run(req: TurnRequest): TurnSession }
interface TurnSession { events: AsyncIterable<TurnEvent>; result: Promise<TurnResult>; abort(reason): void }
interface TurnOutput  { id: string; content: string; sources: SourceItem[]; multimodal: MultimodalPart[] }  // id ⇒ per-item AAD; sources required
type TurnPayload =
  | { delivery: "plaintext"; system; messages: ModelMessage[]; toolSpecs: ToolSpec[] }
  | { delivery: "sealed";    wraps: SskWrap[]; history: SealedItem[]; prompt: SealedItem; reply: SealedSlot; allowedToolCategories }
  | { delivery: "external";  promptMarkdown: string; contextRef: ContextHandle }
interface Capabilities { delivery: ("plaintext"|"sealed"|"external")[]; emits: TurnEventKind[]; canInterject; canStream; sources; ... }
interface TurnSink     { onEvent(e: TurnEvent): Promise<void>; finalize(r: TurnResult): Promise<void> }
class TraceProjector   // event→step, StepStore injected — replaces both observers
function resolveCapabilities(stream, runner): ResolvedCapabilities  // the one gating path
```

**The keystone** is the `delivery` discriminated union: a `SelfDrivenTurnRunner` can structurally only be handed `delivery:"external"`; `resolveCapabilities` refuses to mint a `delivery:"sealed"` payload for any non-attested identity. The trust gradient becomes a **type**, and the E2E-participation decision collapses to one guard.

**Host plug-in.** Companion = `DrivenTurnRunner` via in-process function call (the "wire" is an async iterator). Enclave = `DrivenTurnRunner` over HTTP with `delivery:"sealed"`; `run-turn.ts` keeps doing its work but emits the canonical `TurnEvent` stream sealed before crossing back. External = `SelfDrivenTurnRunner` — `bot:hello`/claim/complete/fail/renew _are_ the wire encoding of `TurnRunner`.

**Drift killed.** Same spine, plus it is the **only** design where the genuinely-divergent external host is on the _same contract_ without pretending it runs `AgentRuntime` — the thing all three share (emit thinking/tools/messages/sources, terminate) becomes the shared surface; the thing they don't share (who drives the model) is the two-tier `delivery` distinction.

**Complexity delta.** Adds the `TurnRunner`/`TurnSession`/`TurnSink` triad + protocol types; removes one observer, the parallel-universe nature of bot-runtimes, two of three gates.

**Risks.** `TurnSession` async-iterable is a real new indirection over a today-direct companion call — pure ceremony if the marketplace never arrives. The sync-`sendMessage`-returns-`messageId` vs async-`complete` mismatch is absorbed by `result: Promise` but the driven adapter's id-expectation must not leak into the protocol. `Capabilities.emits` can rot vs the union unless test-pinned.

---

### Option E — The Harness Contract (TAIP: Threa Agent Integration Protocol)

**Philosophy.** Every agent — OpenClaw, external Pi, ChatGPT, the companion, the enclave — is the same thing: a harness that produces a turn by emitting a **declared subset of one versioned event vocabulary**. Threa is a host that negotiates capabilities, **fills the gaps** a harness can't cover, and seals/persists on its behalf.

**Shape.**

```ts
// In @threa/types (pure data — egress-safe for the enclave)
interface CapabilityManifest {
  taipVersion: string                 // versioned wire contract
  harnessId: string
  trust: "first-party-inproc" | "first-party-attested" | "third-party"
  output: { reply: true; stream?; trace?; sources?; multimodal?; interjection? }  // what it can EMIT
  tools: "threa-managed" | "self" | "none"
  e2e: boolean                        // a CLAIM; the host verifies against trust tier
  triggers: BotInvocationCapability[] // existing supportedCapabilities, reused
}
type EffectiveCapabilities = CapabilityManifest["output"] & { allowedTools: AgentToolName[]; sealed: boolean }
// In @threa/agent-runtime (interfaces only)
interface TurnReply { content: string; sources: SourceItem[]; multimodal: Multimodal[] }  // sources/mm REQUIRED
interface TurnSink  { commit(r: TurnReply): Promise<{messageId; operation?}>; step(e: AgentEvent): Promise<void>; meter?(u): Promise<void> }
interface TurnDriver{ readonly manifest: CapabilityManifest; runTurn(ctx: TurnContext, sink: TurnSink, caps: EffectiveCapabilities): Promise<TurnResult> }
function negotiateCapabilities(m: CapabilityManifest, policy: StreamPolicy): EffectiveCapabilities  // HARD RULE: trust:"third-party" ⇒ e2e forced false
class InProcessTurnDriver implements TurnDriver  // wraps AgentRuntime; used by companion AND enclave
class NetworkTurnDriver   implements TurnDriver  // fronts claim→complete; used by 3P
```

**The keystone** is `negotiateCapabilities`: a single function computes the gate (activating the dead `isToolAllowedByPolicy`) **and** forces `e2e:false` for `trust:"third-party"` regardless of what the manifest claims. One function owns both the gating drift and the trust-boundary drift. Plus **gap-fillers**: if a harness declares `trace:false` but `reply:true`, Threa synthesizes a minimal `context:received`+`message:sent` trace from the reply, **marked as synthesized** so the degradation is _visible_ not silent.

**Host plug-in.** Companion = `InProcessTurnDriver` + `PlaintextSink`. Enclave = the _same_ `InProcessTurnDriver` built from the curated barrel + `SealedSink` (the only sink that can set `e2e:true`). External = `NetworkTurnDriver` fronting the upgraded bot-runtimes protocol; `bot:hello` carries the full manifest.

**Drift killed.** All five §2 symptoms in one structural home each: sources (required `TurnReply` field), interjection (declared manifest field, fails loud at construction), trace parity (one `TraceStepMapper`), lifecycle (one `TurnLifecycle` with the missing `fail`/`park`), and the external parallel universe (bot-runtimes _becomes_ the network half).

**Complexity delta.** +4 named types, −2 large duplicated classes, −2 parallel gating paths; external stops being a parallel universe.

**Risks.** Publishing a **versioned wire contract** (`taipVersion`) is the heaviest new external-facing liability: `AgentEvent` evolves freely today; under TAIP a union change can break 3P harnesses, requiring additive-only evolution forever. Gap-filler output is strictly worse than native and risks masquerading as real unless the "synthesized" marker is enforced. `negotiateCapabilities` becomes a high-stakes chokepoint that must _throw_, not downgrade.

---

## 3. Comparison matrix

Scores are the judges' (three panels; where they split I show the range, leaning on the majority).

| Proposal                       | Drift-elimination                                                     | Adoption-risk (higher = safer)                                                                      | Net-complexity                 | External-agent-fit                                                              | Migration-incrementality                                | One-line verdict                                                            |
| ------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| **A. Ariadne Hexagon**         | 8 — forcing functions are total/typed; root-cause fix                 | **8 (safest)** — pure type changes inside existing config; no wire contract; contained blast radius | ~flat count, ↑ quality         | **5 (weakest)** — external is a side-attached peer; 6–7 ports don't apply to it | High — config already a degenerate `HostAdapters`       | Cleanest _in-loop_ design; external is a relabel. Lowest-risk to start.     |
| **B. Capability Kernel**       | 7 — strong fail-loud-at-`compose()`; but `sources:[]` defeatable      | 5 — heaviest scaffolding for 2 real hosts                                                           | **Heaviest** (8-kind registry) | 6 — external via separate adapter; central abstraction earns nothing for it     | Medium                                                  | Most honest about being "pure tax" until a 3rd in-loop host exists.         |
| **C. Turn Pipeline**           | 6–7 — kills in-loop drift; best `promptBlock`-on-tool idea            | **8 (≈safest)** — names existing structure; live loop untouched; 1-file Step 1                      | **Best net-complexity**        | 6 — `ExternalDispatchLoop` forced into a too-wide `RunLoopStage`                | **Highest** — every step independently shippable        | Lowest-friction realization of the shared spine; external fit is squeezed.  |
| **D. Turn Protocol**           | **9** — only design where external shares the _contract_ structurally | 6.5 — async-iterable indirection; versioning liability (shared w/ E)                                | Moderate                       | **9** — `delivery` union makes trust a type; external is first-class            | High — Step 1 promotes `AgentEvent`→`TurnEvent`         | Inverts the contract to the one thing all 3 hosts share. Best external fit. |
| **E. Harness Contract (TAIP)** | **9** — all 5 symptoms + trust in one home each                       | 6–7 — versioned wire contract is a permanent liability                                              | +4 types, −2 classes           | **9** — bot-runtimes _becomes_ the network half; gap-fillers; trust-tier rule   | High — Step 2 fixes bleeding before any driver refactor | Most operationally complete external story; pays with wire-versioning debt. |

**Where the panels agreed:** all three ranked D and E at the top for _external-agent fit_ and _drift-elimination_, and all three flagged the _versioned wire contract_ as D/E's one genuine new liability. All three named **A or C as the lowest-risk thing to do first**, and all three observed that the _first PR is identical across all five_ (required-sources commit type).

---

## 4. Recommendation & synthesis

### The two-appetite answer

There are two viable directions for two different appetites, and they are **not in conflict** — one is a strict prefix of the other.

- **Minimal-risk now (do this regardless):** the **shared spine** (required-sources commit type, one trace mapper, one gating path), realized in the lightest-touch way — **Option C's wrap-the-loop framing + Option A's typed-port discipline at the commit/trace/interjection edges**. This needs no published wire contract, touches the live loop only to read from typed edges instead of optional fields, and fixes E2EE-9/14, UX-12, the dead gate, and the duplicated observer — all behind seams already in production.

- **Ideal end-state:** **Option D (Turn Protocol) as the structural spine, grafted with Option E (TAIP)'s trust-and-negotiation machinery.** This is the only direction that makes the external marketplace a _first-class structural_ citizen rather than a side adapter, which the product owner named as a **primary** requirement.

### Recommended direction: "Turn Protocol spine + TAIP trust/negotiation skin"

Build around **one contract — produce a turn-event stream — with two tiers (driven / self-driven)**, and graft the sharpest pieces from the other four:

**Grafted, and why:**

1. **From D — the `delivery` discriminated union + `TurnOutput`/`TurnEvent` stream as the core contract.** This is the load-bearing decision: it is the only one of the five where the genuinely-divergent external host shares the _contract_, not just a vocabulary, because the thing all three hosts actually have in common is "emit a turn-event stream and terminate," not "consume `AgentRuntimeConfig`." The `delivery` discriminant makes the trust gradient a _type_ — a self-driven runner can only receive `delivery:"external"`.

2. **From E — the `trust` tier on the manifest + the hard rule `trust:"third-party" ⇒ e2e forced false` inside one `negotiateCapabilities` function.** This is _strictly better_ than D's delivery-union alone: it converts a contradictory claim (a 3P harness asking for sealed) into a **loud rejection** rather than a silent type-level absence, and it folds the dead `isToolAllowedByPolicy` gate into the same chokepoint. Carry **both**: trust tier governs _what payload variants may be minted_; the delivery discriminant governs _which one this turn uses_.

3. **From E — gap-fillers with a visible "synthesized" marker.** The cleanest, fail-loud answer to graceful partial participation: a reply-only harness still gets _a_ trace, explicitly labelled synthesized, so degradation is visible (INV-11), never masquerading as native.

4. **From B / A — the `declaredDisabled(reason)` / `declaredUnsupported(reason)` sentinel.** A _present, loud, telemetry-visible value_ for a capability a host genuinely cannot do, replacing `newMessages?:optional` everywhere. This is the cleanest UX-12 fix and pairs with D's capability declaration.

5. **From C — per-tool `promptBlock` + `categories` on `AgentToolConfig`.** The single best idea for the prompt/toolset-assembler drift that none of the protocol proposals fully address: colocating a tool's prompt block and privacy categories _with the tool_ means a new tool can't be added to one host's prompt and forgotten in the other's.

6. **From all five — the single `TraceProjector`/`TraceMapper` + `StepSink`.** Every proposal independently converges on it; build it first.

**Drop:** TAIP's `taipVersion` published wire contract **until a real external marketplace exists** (INV-36). Internally, keep the `AgentEvent`→`TurnEvent` union free to evolve; version it only at the external boundary, and only when the first non-Threa harness depends on it.

### Why this is _better_, not just different

Every §2 drift symptom traces to one root cause: the loop's edges are untyped/optional, so a host can narrow a responsibility and the compiler stays silent — and the external path is a contract Threa can't see into. This direction attacks the root cause on **both** fronts simultaneously:

- It flips the failure mode from **silent wrong output in prod** to **compile error / construction-time throw / declared-disabled value** — exactly the INV-11 fail-loud principle the codebase already commits to. E2EE-9 becomes "you cannot construct a `TurnSink` that ignores `sources`." UX-12 becomes "you cannot construct a runner without declaring interjection." The dead gate becomes "there is one gating function and every turn flows through it."
- It is the only direction that gives the **primary** requirement — companion, enclave, AND a marketplace of external harnesses looking uniform — a concrete shape: they share one event vocabulary, one trace projection, one gating function, one lifecycle, and differ only at the `delivery` discriminant (who drives the model) and the trust tier (who may receive a sealable sink). That is _"share everything that can be shared, degrade cleanly for what cannot,"_ realized as a type, not a convention.
- It honors every hard constraint verbatim: the shared core stays plaintext-only (`TurnOutput.content: string`); sealing lives in the enclave's `SealedSink`; the curated barrel stays the egress boundary (the protocol carries pure-data types into the enclave); per-item AAD is preserved (the `id` on `TurnOutput` is the per-item handle); and the trust gradient is _strengthened_, not collapsed.

**If you want one sentence for the product owner:** adopt the Turn Protocol as the spine and the Harness Contract's trust-tier-and-negotiation as the skin; do the shared-spine PRs first (they're risk-free and fix the audit findings now), and let the protocol shape harden incrementally behind the bot-runtimes path that already exists.

---

## 5. Third-party plugin ecosystem (REQUIRED)

This is the section the product owner cares about most. The good news: **the on-ramp already exists.** `bot-runtimes` is the embryonic external contract — `BOT_RUNTIME_KINDS` already lists `openclaw`/`custom` (`constants.ts:710`), and `bot:hello`/claim/complete/fail/renew is already a working self-driven harness protocol. The redesign _promotes_ it, it does not replace it.

### 5.1 The published integration contract (the thin contract a 3P harness implements)

A 3P harness runs its **own model and its own agent loop**. It can never consume `AgentRuntimeConfig` — there is no `generateTextWithTools` for Threa to drive. So the contract it implements is **invocation-dispatch + result-ingestion**, i.e. the `SelfDrivenTurnRunner` tier. Concretely, the existing five verbs, upgraded:

1. **Declare** — `bot:hello` carries a full `CapabilityManifest` (today it carries only `supportedCapabilities`, `socket-handler.ts:33`; that becomes `manifest.triggers`).
2. **Receive** — it `claim`s an invocation (`FOR UPDATE SKIP LOCKED`) and gets a `TurnContext` serialized to JSON: `delivery:"external"`, `promptMarkdown`, `trigger`, allowed-tools-as-descriptions, and a `contextRef` callback handle it can use to fetch more history if it wants — **trimmed to what its manifest says it consumes and policy permits**.
3. **Emit** — it POSTs `AgentEvent`-shaped frames to `/steps` as it works and the terminal `message` to `/complete` (today only `finalMessageMarkdown`|`noResponse`, `schemas.ts:117-123`; upgraded to also accept a `TurnOutput` with `sources`/`multimodal`).
4. **Lifecycle** — `renew` (heartbeat), `fail`, `park` (new — bounded retry / DLQ).

**Threa provides:** the trigger, the prompt, a context-fetch handle, capability-scoped permissions, lifecycle/claim TTL, sealing+persistence (on the harness's behalf), and gap-filling. **Threa requires (the floor):** at minimum a single terminal `message`. Everything else is opt-in.

### 5.2 The capability manifest (what a harness declares it can do)

```ts
interface CapabilityManifest {
  taipVersion: "1.0"
  harnessId: string // "openclaw" | "pi-local" | <custom bot id>
  trust: "third-party" // 3P harnesses are always this tier
  output: {
    // derived from AgentEvent / AgentToolResult / SourceItem shapes (INV-31)
    reply: true // the floor — every harness must reply
    stream?: boolean // interim messages before final
    trace?: boolean // emits tool:* / thinking steps
    sources?: boolean // SourceItem[] on replies/steps
    multimodal?: boolean
    interjection?: boolean // honors mid-turn newMessages
  }
  tools: "self" // a 3P harness brings its own tools/model
  e2e: false // a CLAIM; negotiateCapabilities will force this false anyway
  triggers: ("mentionable" | "active-scratchpad" | "session-control")[] // existing BOT_INVOCATION_CAPABILITIES
}
```

The `output` block is the **negotiation surface** for partial participation — and it is _derived from the emittable shapes_ (INV-31) so it cannot drift from what's actually renderable.

### 5.3 Capability negotiation + graceful degradation (Threa fills the gaps)

- **Reply-only ChatGPT wrapper** declares `{ reply: true }`. Threa's gap-filler synthesizes a `context:received` + a single `message:sent` trace step from the final reply, **marked "trace synthesized (harness emits none)"** so the user sees an honest, degraded trace rather than a blank one or a fake-native one.
- **Richer OpenClaw harness** declares `{ reply, trace, sources }` and POSTs `/steps`; those frames run through the **same** `TraceProjector` as the companion, so its trace and citations render identically.
- **Degradation is per-feature, declared, and loud.** An undeclared capability the harness tries to use (e.g. a `/steps` POST when `trace:false`, or sources when `sources:false`) is **rejected at the normalization boundary** (INV-11), never silently accepted. This mirrors how the in-loop core already treats `observers`/`sources`/`multimodal` as optional — the manifest just makes it explicit and negotiated.

### 5.4 Trust / sandbox boundary — the explicit E2E rule

**The rule, stated plainly:** a third-party harness **can never touch an E2E stream.** It is plaintext-only, by hard gate, for the same reason it is today — it has no SSK and cannot seal, and it is arbitrary external code under a workspace-scoped key, not the first-party attested enclave.

This is enforced as a **single typed guard**, not scattered checks:

```ts
function negotiateCapabilities(m: CapabilityManifest, policy: StreamPolicy): EffectiveCapabilities {
  if (m.trust === "third-party" && policy.e2eEnabled) {
    throw new ForbiddenError("third-party harnesses cannot participate in E2E streams")
  }
  const sealed = m.trust === "first-party-attested" && policy.e2eEnabled // ONLY the enclave
  // ... fold isToolAllowedByPolicy(policy.allowedToolCategories, tool) for every tool here ...
}
```

This _consolidates_ today's scattered guards — `invocation-outbox-handler.ts:97` (`if (stream.e2eEnabled === true) return`) and the four `assertNotE2eStream` call-sites (`handlers.ts:1113,1666,1746`) — into one declarative rule on the trust tier. The `delivery` union enforces it structurally too: a `SelfDrivenTurnRunner` can only ever be handed `delivery:"external"` (plaintext), never `delivery:"sealed"`. **E2E participation for anything other than the attested enclave stays the explicitly-deferred decision** — this design makes that a one-line guard to flip behind real attestation, not a refactor.

> **Honest caveat to flag (not block):** callback trust today is one shared `INTERNAL_API_KEY` header, and enclave attestation is currently decorative (E2EE-21/22). Admitting less-trusted hosts strengthens the argument for **per-runner identity** (distinguish the enclave from a 3P harness at the trust check) — that is net-new work, not a pre-existing guarantee, and should land before the trust tier is load-bearing.

### 5.5 Install / auth / routing (how a user adds and scopes a plugin)

- **Install:** a user adds e.g. OpenClaw in workspace settings, which registers a bot with a manifest and mints a `threa_bk_*` key (the existing socket-auth path). This is the embryo today.
- **Auth:** `threa_bk_*` workspace-scoped key + socket-auth + (future) per-runner identity + BIK registration. BIK becomes the explicit "this runner is requesting sealed-tier" signal that `negotiateCapabilities` evaluates against attestation.
- **Routing:** a stream's "Ariadne" binding gets an optional `harnessId` (default `null` = the in-house companion). Setting it to an installed plugin routes that stream's invocations to the `NetworkTurnDriver` for that harness. Mention/active-scratchpad dispatch already routes to bots (`invocation-outbox-handler.ts:119`); this just makes "be the stream's _primary_ agent" a routing option alongside "be mentionable."
- **Bounded lifecycle:** add a `maxAttempts` cap + park-to-DLQ on the claim loop (the brief flags an unbounded `attempts` increment in the repo — confirm and bound it). The in-process hosts get this for free via the shared `TurnLifecycle.park`.

### 5.6 How companion + enclave relate to this contract

**Same contract, privileged internal fast-path.** Companion and enclave are `DrivenTurnRunner`s (TAIP's `InProcessTurnDriver`) — they implement the _in-process half_ of the same protocol and run `AgentRuntime` internally. They do **not** pay a network hop: companion's "wire" is an async iterator / direct function call; the enclave's is the existing HTTP callback. They are privileged in exactly two ways, both typed:

1. They are the only tiers handed `delivery:"plaintext"` / `delivery:"sealed"` payloads (the enclave alone gets `sealed`, gated on `trust:"first-party-attested"`).
2. They run `AgentRuntime` directly rather than their own loop.

So companion, enclave, and the marketplace all look uniform to Threa (one event vocabulary, one trace, one gate, one lifecycle), sharing everything that _can_ be shared and differing only where physics forces it: who drives the model, and who may receive a sealable sink.

### 5.7 Pi-specific assumptions that must be lifted first

Before claiming generality, the "generic" dispatcher must shed its Pi-isms (verified):

- `extractMentionSlugs` uses an **English/ASCII-only** regex `/@([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/g` (`invocation-outbox-handler.ts:25`) — INV-54 tension.
- The "missing link" notice and active-scratchpad path depend on `bot_runtime_session_links` that only Pi creates, and the notice hardcodes Pi-specific copy. Lift these into per-`BotRuntimeKind` config.

---

## 6. Migration sketch (incremental, drift reduced early, no big-bang)

Each step is a shippable PR-sized change behind seams already in production. **The first PR is identical across all five proposals, so it commits you to nothing.**

| Step  | Change                                                                                                                                                                                                                                                                                                                                                                                          | Files                                                                                                                                                                                       | Drift fixed                                         | Blast radius                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **1** | Make `sendMessage`/commit take a payload with **required** `sources` + `multimodal`; thread sources into `EnclaveSealedReply`.                                                                                                                                                                                                                                                                  | `agent-runtime.ts:64-67` (config type), `apps/enclave/src/agent/run-turn.ts:203` (stop destructuring `{ content }`), `EnclaveSealedReply` type + consume-side (partly built on this branch) | **E2EE-9**                                          | One host's commit closure; compiler finds every caller                                           |
| **2** | Extract the shared `TraceProjector`/`TraceMapper` from `SessionTraceObserver`; reimplement `EnclaveTraceObserver` as the same mapper + a sealing `StepSink`. Thread `trace.sources`. Delete the mirrored state machine.                                                                                                                                                                         | `runtime/session-trace-observer.ts`, `apps/enclave/src/agent/trace-observer.ts`                                                                                                             | **E2EE-14**, **#5**                                 | Two observer files; no loop change                                                               |
| **3** | Move per-tool `promptBlock` + `categories` onto `AgentToolConfig`; make prompt-builder + toolset data-driven; **turn on `gateTools`/`isToolAllowedByPolicy` for companion**.                                                                                                                                                                                                                    | `agent-tool.ts`, `companion/tool-set.ts`, `companion/prompt/system-prompt.ts`, `tool-privacy.ts:116`                                                                                        | **#8** (dead gate), toolset/prompt drift            | Tool definitions + both assemblers                                                               |
| **4** | Emit the initial `context:received` from the loop/dispatch entry; remove the out-of-band `traceObserver.emitContext(...)` synthesis.                                                                                                                                                                                                                                                            | `agent-runtime.ts`, `run-turn.ts:221-227`, `persona-agent.ts`                                                                                                                               | **#4**                                              | Both hosts' trace lead-in                                                                        |
| **5** | Give the enclave a real `InterjectionSource`/`newMessages` provider **or** an explicit `declaredUnsupported(reason)`; add the missing enclave `/fail` route + bounded park/DLQ.                                                                                                                                                                                                                 | `run-turn.ts`, enclave session-runner, `enclave-runtimes/**`                                                                                                                                | **UX-12**, **#6**                                   | Enclave lifecycle                                                                                |
| **6** | Introduce `TurnRunner`/`TurnSession`/`TurnSink` (or `TurnDriver`); wrap `AgentRuntime.run()` to expose the event-stream shape; migrate companion `persona-agent` to build a `TurnContext` + sink (in-process, no wire change).                                                                                                                                                                  | `packages/agent-runtime`, `persona-agent.ts`                                                                                                                                                | structural spine                                    | Companion assembly only                                                                          |
| **7** | Make the enclave dispatch implement the same `TurnRunner` over HTTP (mostly renaming its callback bundle into a sink).                                                                                                                                                                                                                                                                          | `enclave-runtimes/**`, `backend-callbacks.ts`                                                                                                                                               | structural spine                                    | Enclave transport                                                                                |
| **8** | **External on-ramp:** wrap the live bot-runtimes claim→complete behind the `NetworkTurnDriver`; extend `bot:hello` with the `CapabilityManifest` `output` block; extend `/complete`+`/steps` to accept `AgentEvent`/`TurnOutput` payloads while keeping `finalMessageMarkdown` as the `{reply:true}` floor; add `negotiateCapabilities` with the trust-tier E2E rule; de-Pi-ify the dispatcher. | `bot-runtimes/socket-handler.ts:33`, `public-api/schemas.ts:117`, `public-api/handlers.ts:546`, `invocation-outbox-handler.ts:25,97`                                                        | external parallel universe; consolidates E2E guards | External path; **existing Pi/OpenClaw harnesses keep working at the reply-only tier throughout** |

The live loop is touched once (Step 6) and only to expose an event stream; the live external path is never rewritten — it is wrapped (Step 8). Steps 1–3 alone clear the entire audit's high/medium findings and are worth doing immediately regardless of which end-state you commit to.

**Where bot-runtimes is the on-ramp:** Step 8 is entirely additive to a working protocol. `BOT_RUNTIME_KINDS` already names `openclaw`/`custom`; `supportedCapabilities` already exists; claim/renew/complete/fail already work. The migration is "extend the manifest, accept richer payloads, add a trust-gate function, lift the Pi-isms" — not "build a plugin system."

---

## 7. Open questions / things to validate (spike before committing)

1. **Async-iterable cost on the hot in-process path.** Does wrapping companion's today-direct call in a `TurnSession`/event-stream add measurable allocation/latency? Spike: benchmark the iterator wrapper vs the direct path under a realistic turn. If it's non-negligible, prefer the lighter Pipeline/Hexagon framing for the in-loop hosts and keep the stream contract at the _wire_ boundary only.

2. **Per-runner identity beyond the shared `INTERNAL_API_KEY`.** The trust-tier rule (§5.4) is only load-bearing if Threa can _distinguish_ the attested enclave from a 3P harness at the gate. Spike: design per-runner credentials + real enclave attestation (closes E2EE-21/22) and prove `negotiateCapabilities` can authoritatively read `trust`.

3. **`sources:[]` willful defeat.** Required-`sources` typing stops _accidental_ drops but not a host passing `[]`. Spike a test that asserts: a turn whose tool results carried source-bearing output **commits non-empty sources**, so the type guarantee isn't silently defeated by review oversight.

4. **`RunLoopStage`/`TurnRunner` width vs the sync-`messageId` expectation.** The driven loop expects `commit` to return a `messageId` synchronously; an async `complete` cannot. Spike: prove the driven adapter's id-expectation stays _inside_ the driven runner and does not leak into the protocol surface, and that `TurnSession.result: Promise` absorbs the deferral cleanly for the external tier.

5. **Capability-list ↔ union derivation.** Validate that `Capabilities.emits` / `manifest.output` can be _derived_ from the `AgentEvent`/`AgentToolResult`/`SourceItem` shapes (INV-31) with a test that fails if an emittable kind is not declarable — otherwise the negotiation surface rots.

6. **Gap-filler quality + visibility.** Spike the synthesized-trace UX for a reply-only harness and confirm the "synthesized" marker is rendered prominently enough that users don't mistake it for a native trace.

7. **Multimodal delivery divergence.** The shared loop injects images as inline `image: url` user messages (`agent-runtime.ts:651-659`); the enclave push-inlines decrypted parts (`run-turn.ts:257-289`). Validate whether `TurnOutput.multimodal` can carry both shapes cleanly or whether a `MultimodalDelivery` capability is needed.

8. **Wire-versioning trigger.** Confirm the decision to _defer_ `taipVersion` until the first non-Threa harness ships — and define the additive-only evolution policy that kicks in at that moment, so internal `AgentEvent` evolution stays free until then.

Key starting files for the spike: `packages/agent-runtime/src/runtime/agent-runtime.ts` (loop + config seam), `agent-tool.ts` + `agent-observer.ts` (tool/observer contracts), `apps/backend/src/features/agents/persona-agent.ts` (companion — the capability ceiling), `apps/enclave/src/agent/run-turn.ts` + `trace-observer.ts` (enclave assembly + sealing), `apps/backend/src/features/bot-runtimes/**` + `apps/backend/src/features/public-api/bot-*` (the external on-ramp), `packages/types/src/tool-privacy.ts:116` + `constants.ts:710-774` (gating + capability/runtime vocabularies), and `docs/audits/e2ee-enclave-audit-2026-06.md` (drift symptoms).
