# Design Doc: `ExternalTurnDriver` (Phase 2.3)

**Status:** proposal — review before implementation
**Audience:** engineering
**Related:** `docs/plans/agent-runtimes-unification-redesign.md` (§2.2, §2.3, §2.4 row 2.3, §2.6, §2.7, §2.8)
**Scope anchor (authoritative):** §2.4 row 2.3 — "ExternalTurnDriver wraps claim/complete; bot:hello manifest; /complete sources; context handle; reject-undeclared at boundary"

## 0. TL;DR

`ExternalTurnDriver` is the third member of the `TurnDriver` family, but it is
**fundamentally not blocking**. The in-process drivers (`InProcessTurnDriver`,
`EnclaveTurnDriver` at `packages/agent-runtime/src/runtime/turn-driver.ts:165,185`)
run `AgentRuntime` synchronously and `await runTurn(...)` to completion. The
external path is **pull-based and durable**: a bot claims an invocation in one
HTTP request (`handlers.ts:865`), POSTs `/steps` over time (`handlers.ts:984`),
and `/complete`s or `/fail`s in a **later, separate request**
(`handlers.ts:1052,1199`), surviving runner restarts via claim/renew/park up to
`BOT_CLAIM_MAX_ATTEMPTS` (`service.ts:447-466`). There is no in-process loop for
the backend to `await`.

**Recommendation: split `TurnDriver` into a base + two sub-interfaces.**
`ExternalTurnDriver` implements `DispatchedTurnDriver` with a
`dispatchTurn(request, dispatchBinding): Promise<TurnDispatchReceipt>` that
returns once the invocation row is created and `bot_invocation:available` is
emitted. The "sink edges" are not closures resolved in one stack frame; they are
**realized later by the existing durable verb handlers**, which the design
formalizes as the driver's _dispatch binding_ and _resolution adapters_.
Crucially, much of the downstream machinery already exists in the working tree
(the shared `TraceProjector` normalization at `trace-steps.ts:60,192`, the
synthesized-trace floor at `trace-steps.ts:261`, contentJson mention extraction
at `invocation-outbox-handler.ts:108-109`, and park/DLQ at `service.ts:447`).
This phase is therefore primarily a **typed-seam consolidation + manifest +
context handle + boundary rejection**, not a green-field build.

## 1. The interface decision

### 1.1 Why uniform `runTurn` is rejected

The current `TurnDriver` contract (`turn-driver.ts:121-125`) is:

```ts
interface TurnDriver {
  readonly delivery: TurnDelivery
  runTurn(request: TurnRequest, sink: TurnSink): Promise<TurnResult>
}
```

`TurnResult = AgentRuntimeResult` (`turn-driver.ts:119`) — `sentMessageIds`,
`messagesSent`, `lastProcessedSequence`, usage. The two call sites consume
exactly these fields immediately after the await: `persona-agent.ts:821-878`
reads `loopResult.sentMessageIds` / `noMessageReason` / `lastProcessedSequence`
to reconcile superseded messages and persist the snapshot; `run-turn.ts:328`
awaits and then runs the post-turn digest.

Making external `runTurn` return a `TurnResult` "describing the dispatch" would
either:

- **lie about the shape** — `sentMessageIds: []` at dispatch time is
  structurally indistinguishable from a genuine no-response turn, and
  `persona-agent.ts:823` (`loopResult.sentMessageIds.length === 0`) already
  branches on exactly that, so a caller could not tell "dispatched, pending"
  from "completed, empty"; or
- **force a cross-request rendezvous** — block the backend request until the
  bot's _later_ `/complete` arrives, coupling a backend request's lifetime to
  the bot's wall-clock and **weakening restart tolerance** (a backend restart
  mid-await orphans a turn that the durable claim/renew machinery was
  specifically built to survive).

Either way it violates INV-11 (the empty-result ambiguity is a silent fallback)
and the §2.7 design intent (the external and enclave transports converge on
_claim → heartbeat/poll → complete_, a lifecycle that is durable by
construction).

### 1.2 Why a single bolt-on method is rejected as the _primary_ shape

Adding `dispatchTurn` alongside `runTurn` on one fat interface leaves every
consumer holding an interface with two methods where exactly one is valid per
driver, and nothing in the type system stops `persona-agent.ts` from calling
`dispatchTurn` on the in-process driver or the dispatcher from being `await`ed
for a result. That is an INV-11 trap (a runtime throw where a compile error
belongs). We adopt the `dispatchTurn` _method_ but place it on a _distinct
sub-interface_, so the dispatcher and the synchronous drivers are not
structurally interchangeable.

### 1.3 Chosen shape — base + two sub-interfaces

Add to `packages/agent-runtime/src/runtime/turn-driver.ts`:

```ts
/** Shared by every driver: which delivery it serves. Dispatch routes by this. */
export interface BaseTurnDriver {
  readonly delivery: TurnDelivery
}

/**
 * A driver that runs the loop in-process (or behind a sealed HTTP callback the
 * backend awaits) and resolves the whole turn within one call. The companion
 * and the enclave. Unchanged contract — this is today's `TurnDriver`.
 */
export interface SynchronousTurnDriver extends BaseTurnDriver {
  runTurn(request: TurnRequest, sink: TurnSink): Promise<TurnResult>
}

/**
 * A driver that hands the turn to a runner it does not control and returns once
 * the work item is durably enqueued. The turn's sink edges are realized LATER,
 * by the verb handlers, against the same projection layer (§2.2 fixed point) —
 * never within this call. The external bot path; later, the pulled enclave (§2.7).
 */
export interface DispatchedTurnDriver extends BaseTurnDriver {
  dispatchTurn(request: TurnRequest, binding: TurnDispatchBinding): Promise<TurnDispatchReceipt>
}

/** Any driver. Dispatch narrows by `delivery` (or by an `in`-guard on the method). */
export type AnyTurnDriver = SynchronousTurnDriver | DispatchedTurnDriver
```

`TurnDriver` is retained as an **alias of `SynchronousTurnDriver`** so the two
existing call sites and the barrel exports (`agent-runtime/src/index.ts:22`,
`run-turn.ts:328`, `persona-agent.ts:172`) compile unchanged — **no edit to
either blocking call site is required by this phase**.

**Justification against the in-process drivers.** The synchronous drivers
genuinely _can_ return a `TurnResult` — they hold the `AgentRuntimeResult` in
the same stack frame. The dispatcher genuinely _cannot_ — at dispatch time the
model has not run, no message exists, no sources exist. The type split makes
that asymmetry a compile-time fact instead of a runtime convention. It also
matches §2.7's end-state precisely: when the enclave inverts to pull,
`EnclaveTurnDriver` migrates from `SynchronousTurnDriver` to
`DispatchedTurnDriver` _by changing which sub-interface it implements_, and
`dispatchTurn` is already the shared shape.

### 1.4 The dispatch binding and receipt

`dispatchTurn` does not take a `TurnSink` (closures resolved now). It takes a
**binding** — the durable identity the later verb handlers use to _re-derive_
the sink edges:

```ts
/**
 * What dispatch knows at hand-off that the LATER verb handlers need to resolve
 * the turn's sink edges. This is the durable analogue of `TurnSink`: instead of
 * closures invoked in one stack frame, it names the rows the verb handlers read.
 * (Most of these already travel as `createInvocation` params, service.ts:286.)
 */
export interface TurnDispatchBinding {
  workspaceId: string
  actorId: string // the bot
  rootStreamId: string
  activeStreamId: string
  responseStreamId: string
  sourceMessageId: string
  authorUserId: string
  trigger: TurnTrigger // see §3 — maps to BotInvocationTrigger
  requiredCapability: BotInvocationCapability
  mentionedActorSlugs?: string[]
  targetInstanceId?: string | null
  targetRuntimeSessionId?: string | null
  /** Forward-compat (Open-Q2): inline last-N history shipped in the claim payload. */
  contextHandle?: ExternalContextHandle
  metadata?: Record<string, unknown>
}

/** Returned once the invocation row exists and `bot_invocation:available` is emitted. */
export interface TurnDispatchReceipt {
  invocationId: string
  status: "dispatched" | "deduplicated" // deduplicated = idempotent re-insert (service.ts:348)
}
```

`ExternalTurnDriver.dispatchTurn` is a thin wrapper over
`BotRuntimeService.createInvocation` (`service.ts:286`): it maps the binding
onto `createInvocation` params, returns the receipt. **It is constructed once**
(INV-13) with `{ service: BotRuntimeService }`, mirroring how
`InProcessTurnDriver` is constructed once at `persona-agent.ts:175`.

```ts
export class ExternalTurnDriver implements DispatchedTurnDriver {
  readonly delivery: TurnDelivery = TurnDeliveries.EXTERNAL
  constructor(private readonly deps: { service: BotRuntimeService }) {}
  dispatchTurn(request: TurnRequest, binding: TurnDispatchBinding): Promise<TurnDispatchReceipt>
}
```

**Placement (INV-51/52).** `ExternalTurnDriver` reaches into `BotRuntimeService`
(a backend feature) and so cannot live in `packages/agent-runtime` (which must
stay free of `apps/backend` imports). It lives in
`apps/backend/src/features/bot-runtimes/external-turn-driver.ts` and is exported
from that feature's barrel. The **interfaces** (`DispatchedTurnDriver`,
`TurnDispatchBinding`, `TurnDispatchReceipt`, `SynchronousTurnDriver`,
`BaseTurnDriver`) live in `turn-driver.ts` next to their synchronous siblings
and are re-exported from the package barrel. This keeps "one vocabulary, three
drivers" (§2.2) while respecting the dependency direction.

## 2. How each `TurnSink` edge maps onto the durable verbs

The in-process `TurnSink` (`turn-driver.ts:77-93`) has five edges. For the
external path they are **realized by different actors at different times** — the
bot produces them, the verb handlers project them.

| `TurnSink` edge                   | External realization                                                                                                           | Verb / handler                                                                                                 | Declared status                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `commitMessage(commit) → receipt` | The bot's final reply. `commit.content` ← `finalMessageMarkdown`; `commit.sources` ← **new** `/complete` `sources` field (§4). | `completeBotInvocation` (`handlers.ts:1052`); message at `handlers.ts:1083`                                    | **Supported**                                                                      |
| `observers` / trace               | `/steps` POSTs normalized into `AgentEvent`s, fed to the **shared** `TraceProjector`. Already built.                           | `recordBotInvocationStep` → `botInvocationStepEvents` (`trace-steps.ts:60`) → projector (`trace-steps.ts:192`) | **Supported** (synthesized floor, `trace-steps.ts:261`, for reply-only — N-6)      |
| `shouldAbort()`                   | Cancellation toward the runner. Today: nothing (N-3).                                                                          | claim/renew (`handlers.ts:960`) — renew response is the natural carrier (§2.7)                                 | **`declaredUnsupported(...)`** — forward-compat hook, not built this phase         |
| `toolSignalProvider`              | Per-tool cancel. The bot owns its own loop and tools.                                                                          | —                                                                                                              | **`declaredUnsupported("the harness drives its own tools")`**                      |
| `newMessages` interjection        | Mid-turn awareness. Bots have no channel for it.                                                                               | —                                                                                                              | **`declaredUnsupported("third-party harnesses don't receive mid-turn messages")`** |

**Why a sink-shaped object still appears.** The verb handlers do not literally
receive a `TurnSink`. But the design names a `TurnSinkResolution` type that
documents, per edge, which handler realizes it and which are
`declaredUnsupported`, so the external driver's surface is _legible against the
same vocabulary_ as the in-process drivers. The `declaredUnsupported` sentinels
(`turn-driver.ts:57-65`) are reused verbatim.

### 2.1 `commitMessage` sources normalization (INV-11 + §2.2.1)

`TurnCommit.sources` is **required** in the contract (`turn-driver.ts:39-42`).
The wire is optional-but-normalized: `completeInvocationSchema` (`schemas.ts:113`)
gains `sources?: SourceItem[]`, and `completeBotInvocation` normalizes a missing
field to `[]` before it crosses into any `TurnCommit`-shaped internal value.
Open-Q4 (the "`sources: []` willful defeat" test) applies here.

## 3. `TurnRequest` → bot invocation mapping

`TurnRequest` (`turn-driver.ts:101-117`) is built for the _in-process loop_. The
external runner **brings its own model, prompt, and tools** (§2.3). So the
mapping is deliberately **lossy and declared**, not a field-by-field copy:
`model`/`modelString`/`systemPrompt`/`tools`/`maxTokens`/`temperature`/
`maxIterations`/`costContext`/`telemetry` are all **dropped**; the trigger
identity maps to `TurnDispatchBinding.trigger` + `requiredCapability`, and
history rides the context handle (§4.2), not the loop's message array.

**Consequence for the call site.** This phase introduces a `TurnTrigger`
vocabulary (mapping to `BotInvocationTrigger`) and replaces the two direct
`createInvocation` calls (`invocation-outbox-handler.ts:129,189`) with
`externalTurnDriver.dispatchTurn(request, binding)` (one mapping, INV-35).
Mention extraction (`:108-109`) and the active-scratchpad branch are unchanged.

## 4. The four named Phase-2.3 deltas

### 4.1 `bot:hello` manifest (triggers/output) — additive, non-breaking

Today `bot:hello` carries `supportedCapabilities: BotInvocationCapability[]`
(`socket-handler.ts:33`). §2.2.3/§2.3 reframe this as `manifest.triggers`
**unchanged on the wire**, plus a **new optional `output` block** (reply / trace
/ sources / multimodal / interjection) defaulting to **reply-only**:

```ts
manifest?: {
  // `triggers` is the existing `supportedCapabilities`, accepted under either
  // key for one release; the existing field stays authoritative so Pi/OpenClaw
  // are untouched.
  output?: {
    reply: boolean          // default true
    trace?: boolean         // default true (steps are already optional)
    sources?: boolean       // default false — gates the §4.3 /complete sources
    multimodal?: boolean    // default false — DEFERRED wire
    interjection?: boolean  // default false — always declaredUnsupported today
  }
}
```

The manifest is **persisted** so the verb handlers can validate against it
without a live socket (persistence shape — column vs. tracking table — is an
open item, §9). The `bot:hello` ack is unchanged.

### 4.2 Context handle (N-4) — lean inline-first (Open-Q2)

Per Open-Q2 the recommendation is **inline last-N history in the claim
response**, matching the enclave's assignment shape (30 messages). The claim
response (`handlers.ts:938-957`) gains an optional `context` field carrying
recent, access-scoped conversation history. Type it as `ExternalContextHandle`
so the _fetch-back ref_ variant can be added later without a wire break:

```ts
type ExternalContextHandle =
  | { kind: "inline"; messages: ExternalHistoryMessage[] }
  | { kind: "ref"; contextRef: string; expiresAt: string } // DEFERRED, not built now
```

Access scoping reuses the existing per-location access spec, not the bot's
standing API scopes.

### 4.3 `/complete` sources

`completeInvocationSchema` (`schemas.ts:113`) gains `sources?: SourceItem[]`;
`completeBotInvocation` (`handlers.ts:1083`) threads them onto the created
message and normalizes to `[]` internally (§2.1). Gated by
`manifest.output.sources` (§4.4). This is the N-5 floor-raising delta.

### 4.4 Reject-undeclared at the boundary (INV-11)

The single new invariant-bearing rule. A `assertCapabilityDeclared(manifest,
capability)` chokepoint invoked at the start of each durable verb handler that
consumes a manifest-gated capability:

- `recordBotInvocationStep` (`handlers.ts:984`) — `/steps` with
  `manifest.output.trace === false` ⇒ **reject loudly** (`HttpError 400
CAPABILITY_NOT_DECLARED`).
- `completeBotInvocation` (`handlers.ts:1052`) — `sources` present but
  `manifest.output.sources !== true` ⇒ reject.
- claim (`handlers.ts:865`) — require the claimed invocation's
  `requiredCapability` to be in the bot's declared `triggers` (formalize the
  implicit `claimOne` filter at `service.ts:463` as the same loud assert).

The chokepoint is **one function** (INV-35) reused across the three handlers,
placed in `bot-runtimes/` and imported by the public-api handlers via the
barrel (INV-52).

## 5. Migration & back-compat constraints

1. **No blocking call-site edits.** `TurnDriver` aliases `SynchronousTurnDriver`.
2. **No breaking wire change.** Every wire delta is additive and optional:
   `bot:hello.manifest`, `/complete.sources`, claim-response `context`. Existing
   Pi/OpenClaw harnesses keep working untouched.
3. **Reject-undeclared is opt-in by manifest presence.** A harness with no
   persisted manifest is treated as the legacy default profile (reply + trace,
   no sources); the loud rejection only fires once a manifest narrows the
   profile.
4. **`createInvocation` is wrapped, not duplicated** (`service.ts:286`); claim/
   renew/park semantics unchanged.
5. **Pi-isms already removed upstream** (Phase 0.6).

## 6. Forward-compatibility (note only)

- **Sealed external delivery (§2.6).** `delivery: "external"` and `"sealed"`
  stay orthogonal; `DispatchedTurnDriver` is the shape the pulled enclave (§2.7)
  will also implement. Route by `delivery` only — never `instanceof`.
- **`/complete` multimodal** deferred; `manifest.output.multimodal` reserved,
  wire field not added now.
- **Context handle ref variant** — typed, not built.
- **Usage/cost reporting** from external runners — out of scope.
- **Versioned wire contract (`taipVersion`)** — deferred.

## 7. File-by-file change list (interfaces/signatures only)

**New files**

- `apps/backend/src/features/bot-runtimes/external-turn-driver.ts` —
  `class ExternalTurnDriver implements DispatchedTurnDriver`.
- `apps/backend/src/features/bot-runtimes/assert-capability-declared.ts` —
  `assertCapabilityDeclared(manifest, capability): void` (throws `HttpError 400`).
- `external-turn-driver.test.ts`, `assert-capability-declared.test.ts`.

**Edited files**

- `packages/agent-runtime/src/runtime/turn-driver.ts` — add `BaseTurnDriver`,
  `SynchronousTurnDriver`, `DispatchedTurnDriver`, `AnyTurnDriver`,
  `TurnDispatchBinding`, `TurnDispatchReceipt`, `TurnTrigger`,
  `ExternalContextHandle`, `TurnSinkResolution`; alias
  `TurnDriver = SynchronousTurnDriver`. No change to the existing driver classes.
- `packages/agent-runtime/src/index.ts` (+ `runtime/index.ts`) — export the new
  interfaces/types (barrel, INV-52).
- `apps/backend/src/features/bot-runtimes/{index,socket-handler,service,
repository,invocation-outbox-handler}.ts` — manifest persist/read; replace the
  two `createInvocation` calls with `dispatchTurn`.
- `apps/backend/src/features/public-api/{schemas,handlers,routes}.ts` —
  `sources` on `/complete`; inline `context` on claim; `assertCapabilityDeclared`
  chokepoints.
- A migration (if manifest uses a table/column) — via the `add-migration` skill.

**Notably NOT edited** (already in place): `trace-steps.ts`, park/DLQ
(`service.ts:447`), mention-from-contentJson (`invocation-outbox-handler.ts:108`).

## 8. Test plan

- **agent-runtime:** `dispatchTurn` rejects non-`EXTERNAL` delivery; type-level
  `// @ts-expect-error` that `ExternalTurnDriver` is not a `SynchronousTurnDriver`
  and `InProcessTurnDriver` is not a `DispatchedTurnDriver`.
- **bot-runtimes:** `dispatchTurn` maps a binding onto `createInvocation` exactly;
  `{ status: "deduplicated" }` on idempotent re-insert. `assertCapabilityDeclared`:
  declared passes, undeclared throws `400`, absent manifest ⇒ legacy default
  passes.
- **public-api handlers:** `/complete` with `sources` + declared ⇒ persisted;
  omitted ⇒ `[]` (Open-Q4). `sources` present but undeclared ⇒ `400`. `/steps`
  with `trace:false` ⇒ `400`; default profile projects as today. Back-compat
  regression: no-manifest, no-sources flow is byte-identical (incl. synthesized
  floor). Claim response includes inline `context`.
- **E2E exclusion regression:** external dispatch into an E2E stream stays
  blocked (`invocation-outbox-handler.ts:98`, `handlers.ts:1082`).

## 9. Open items to resolve before coding

- **Manifest persistence shape** (§4.1 / §6): column on the presence/instance row
  vs. `bot_runtime_manifests` tracking table (INV-57 leans table; read-path
  simplicity leans column). Sibling to §2.8 Open-Q3.
- **`shouldAbort` carrier** — confirm it stays a forward-compat hook
  (declared-unsupported now), not built in 2.3; N-3 cancellation deferred to the
  §2.7 pulled-transport work.
- **Open-Q4 test** placement — share one test helper with the enclave Phase 0.1
  work (INV-35).

## 10. Phasing recommendation

The §2.3 row decomposes into independently-shippable PRs (mirroring 2.1/2.2):

1. **2.3a — `/complete` sources** (additive, decision-free; ships first, no
   manifest gate yet). _Shipped._
2. **2.3b — `bot:hello` manifest (triggers/output) + reject-undeclared
   chokepoint** (needs the manifest persistence decision in §9).
3. **2.3c — `ExternalTurnDriver` + interface split** (the structural seam above).
4. **2.3d — context handle (N-4, inline-first)**.
