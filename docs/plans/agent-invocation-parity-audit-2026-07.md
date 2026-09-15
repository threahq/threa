---
title: Agent Invocation Parity — Audit 2026-07 & Designs
status: audit + proposal
audience: engineering
created: 2026-07-02
related: [agent-runtimes-unification-redesign.md, ariadne-collaborator-roadmap.md, agent-runtime-pluggability.md]
summary: >
  Re-verified audit (2026-07-02) of the three agent surfaces — in-process
  companion (Ariadne), E2EE enclave, external bot-runtimes — three weeks after
  the unification redesign declared Phases 0-2 complete. Verdict: the Turn
  Contract held; the remaining divergence is one new-drift tool gap, one live
  external-path bug, one telemetry hole, and one policy switch. Includes two
  designs: opt-in workspace tools for the enclave, and the @threa/bot SDK.
---

> **Relationship to prior docs.** `agent-runtimes-unification-redesign.md`
> (status notes verified 2026-06-12) is the baseline. This document re-verifies
> its §1.5 capability matrix against the tree on 2026-07-02, audits the ~50
> commits landed since, and adds two committed-shape designs. Where they
> disagree, this document is current.

# Part 1 — Verified state, 2026-07-02

## 1.1 Headline

The unification held. Companion and enclave run the same loop
(`AgentRuntime`), the same `TraceProjector`, the same
`negotiateCapabilities`/`stream_policies` tool gate, the same turn digests and
rolling summary (`run-turn.ts:249,285`), the same `/fail` lifecycle
(`failSessionWithLifecycle` at `session-handlers.ts:859`), and the same cost
recording. Six parity rows suspected of regression were each re-verified and
**all hold**. The external path shares the projection layer, the claim
lifecycle (bounded attempts + park), inline claim context, sources on
`/complete`, and id-based mention resolution.

What remains is small and nameable:

1. **NEW-DRIFT:** `schedule_follow_up` (#1138) is companion-only — the first
   durable-write tool, and the template for every roadmap tool after it
   (delegate_task, save_memo, update_stream_brief). The roadmap's standing
   policy ("each new tool's enclave story is a per-tool follow-up decision")
   makes companion-only the default steady state; without a forcing function
   the tool gap compounds every phase.
2. **LIVE BUG:** `rebindPiRemoteSessionInstance` hardcodes
   `runtimeKind: "pi-local"` (`bot-runtimes/service.ts:359,368`), and
   `rebindInstance` SQL filters `AND runtime_kind = $kind`
   (`repository.ts:540`) — a `claude-code-channel` session link can never
   rebind; the handler 404s every time. Pi works only because the literal
   matches its own kind.
3. **DRIFT:** external turns record zero cost/usage/telemetry — grep of
   `bot-runtimes/` + the public-api bot handlers for
   `costService|recordUsage|otel` returns nothing; the complete schemas carry
   no token field. Companion (per-call) and enclave (at `/complete`, Phase
   0.4) both record.
4. **POLICY-OFF, built:** the sealed external wire (sealed claim/steps/
   complete, `SealedTurnContext`, BIK claim-gating) is code-complete and
   tested behind `EXTERNAL_SEALED_DELIVERY = false`
   (`negotiate-capabilities.ts:35`). Flipping it is consent UX + one line.
5. **Zero enclave commits in the window.** No commit since 2026-06-12 touched
   `apps/enclave/` or `features/enclave-runtimes/`. Nothing regressed — but
   every new capability landed companion/external-only.

## 1.2 Companion vs enclave — verified divergence matrix

Legend: ✅ works · ⛔ absent by design · **bold** = changed since the June
baseline. Rows at parity that were re-verified: unseen-message catch-up
(enclave reopen at `session-handlers.ts:792-825`), turn digests (shared
`formatTurnDigestsForPrompt`, `run-turn.ts:249`), rolling summary (shared
`foldRollingSummary`, `run-turn.ts:285`), stream_policies gating (identical
`negotiateCapabilities` — `persona-agent.ts:638` / `tools.ts:96-99`),
tool-prompt assembly from the surviving toolset, interjection
(implemented pull or loud `declaredUnsupported`, `run-turn.ts:400-409`),
`/fail`, cost recording.

| Capability                                                        | Companion               | Enclave                                  | Classification                                       |
| ----------------------------------------------------------------- | ----------------------- | ---------------------------------------- | ---------------------------------------------------- |
| Message trigger via delivery verdict                              | ✅ `FIRST_PARTY_INPROC` | ✅ `FIRST_PARTY_ATTESTED`                | parity (one chokepoint)                              |
| @mention trigger                                                  | ✅ by actor id (#1043)  | ⛔ mentions ride in ciphertext           | by-design                                            |
| Edit/delete supersede-rerun                                       | ✅                      | ⛔ sealed edits undiffable               | by-design                                            |
| **`schedule_follow_up`**                                          | ✅ #1138                | ⛔ absent                                | **NEW-DRIFT** (§1.4, design in Part 2 context)       |
| **Context bag / Discuss-with-Ariadne span seeding**               | ✅ #1137                | ⛔ plaintext-sourced                     | by-design (inherited — segmenter short-circuits E2E) |
| Conversation highlight / cross-surface stitch                     | ✅                      | ⛔                                       | by-design (same segmenter dependency)                |
| Workspace / GitHub / Linear tools                                 | ✅                      | ⛔ today — **Part 2 designs the opt-in** | by-design → becomes user consent                     |
| Per-persona `enabledTools`                                        | ✅                      | ⛔ hardcoded factory                     | by-design                                            |
| Turn digests / rolling summary / trace / sources / `/fail` / cost | ✅                      | ✅                                       | parity (verified)                                    |
| Prompt caching (C-3)                                              | ❌                      | ❌                                       | parity — still the one §1.7 item open everywhere     |
| OTEL/Langfuse                                                     | ✅                      | ⛔ egress isolation                      | by-design                                            |
| Auto-title                                                        | ✅ server               | ✅ sealed in-enclave                     | parity of intent (N-2 mechanism split stands)        |

Also: the baseline doc's §1.5 row "Prior turns' tool results in context: ❌"
is stale — digest injection ships on both first-party surfaces. Flip to ✅/✅.

## 1.3 External bot — verified matrix (deltas only)

| Capability                                                                                                           | First-party                         | External                                          | Classification                                                |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| Own model/loop/tools                                                                                                 | Threa drives                        | harness drives                                    | by-design                                                     |
| Mention trigger                                                                                                      | id-based                            | id-based (#1043 migrated it too)                  | **parity — Pi-ism regex closed**                              |
| Session control (steer/stop/model/run)                                                                               | n/a                                 | ✅ #1091, kind-routed                             | by-design (external-only, correctly)                          |
| Claim lifecycle, park, renew, orphan cleanup, trace projection, synthesized reply-only trace, sources on `/complete` | ✅                                  | ✅                                                | parity                                                        |
| Inline claim context                                                                                                 | digests + summary + budgeted window | last-30 inline, withheld unless plaintext verdict | partial by-design (harness owns continuity via session links) |
| Cost/usage/OTEL                                                                                                      | ✅ both surfaces                    | **nothing**                                       | **DRIFT — D1**                                                |
| Session-link rebind                                                                                                  | n/a                                 | **broken for claude-code-channel**                | **BUG — D2**                                                  |
| Mid-turn interjection                                                                                                | ✅ / enclave pull                   | `declaredUnsupported`                             | DRIFT (carrier buildable on renew) — D3                       |
| Edit/delete supersede                                                                                                | ✅                                  | absent                                            | DRIFT (low) — D4                                              |
| Sealed delivery                                                                                                      | enclave native                      | built, `EXTERNAL_SEALED_DELIVERY=false`           | POLICY-OFF — D5                                               |
| Multimodal on wire                                                                                                   | deferred                            | deferred                                          | parity (deliberate)                                           |

**"Generic third-party harness" verdict: ~85% real.** The
reply/mention/trace/sealed surface is genuinely generic and exercised by two
live kinds. The session-lifecycle surface is a two-member allowlist
(`availability.ts:185-190`, `createRuntimeSessionSchema` enumerates
`["pi-local","claude-code-channel"]`) with one seam (rebind) still literally
Pi-only — real for stateless harnesses, aspirational for stateful ones until
D2 + the `*PiRemote*` → `*RuntimeSession*` rename land (INV-49).

## 1.4 Recent drift (2026-06-12 → 2026-07-02), per feature

| Feature                                                 | Surfaces                 | Enclave                                                                                                            | External                         | Verdict                                                                                                |
| ------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `schedule_follow_up` #1138                              | companion                | deliberately excluded (roadmap backlog names the two missing pieces: sealed `note`, enclave-dispatching fire path) | n/a (own tools)                  | declared gap, clean degrade — but the compounding template                                             |
| Discuss-with-Ariadne span seeding #1137                 | companion                | untouched; inherited by-design exclusion                                                                           | n/a                              | flag: not `declaredUnsupported`-visible in UI                                                          |
| Mention id-resolution #1043/#1044                       | companion + external     | correctly untouched (ciphertext)                                                                                   | ✅ closed the ASCII-regex Pi-ism | parity fix                                                                                             |
| Claude Code session control #1091                       | external                 | n/a                                                                                                                | ✅ new capability                | partial de-Pi-ification: command-dispatch layer renamed, session-link layer untouched (D2 lives there) |
| Conversations fixes, provenance chips #1131/#1140/#1141 | plaintext GAM / frontend | n/a                                                                                                                | n/a                              | no parity implication                                                                                  |

**Process recommendation (the forcing function):** every PR adding an agent
tool or trigger must state its enclave and external story — implement, or
`declaredUnsupported(reason)`, or by-design-N/A with the reason — as a
checklist item. That is the Turn Contract's own discipline (§2.2 item 4)
applied at review time, and it is what keeps the roadmap's per-tool policy
from silently reopening the gap the redesign closed.

## 1.5 Ranked fix list

1. **D2 — rebind bug** (small, live): thread `runtimeKind` from the resolved
   link through `rebindPiRemoteSessionInstance` → `rebindInstance` + presence
   upsert; drop both `"pi-local"` literals; add a `claude-code-channel`
   rebind test; rename the `*PiRemote*` service methods (INV-49).
2. **D1 — external cost hole**: optional
   `usage: { inputTokens, outputTokens, model }` on
   `completeInvocationSchema`/sealed variant; record via shared
   `costService.recordUsage` (`origin: "user"`,
   `functionId: "external-bot-turn"`) in the `/complete` transaction when the
   RUNNING→COMPLETED transition wins. Self-attested is acceptable (INV-19
   beats nothing).
3. **Enclave follow-up parity** (the NEW-DRIFT row): tool side — an enclave
   `schedule_follow_up` whose `execute` posts to a new session callback
   (interjection-pull pattern: internal key + session-bound callback token);
   fire side — `AgentFollowUpService.fire` branches on E2E streams to
   `enqueueEnclaveInvocation` (the reopen path at `session-handlers.ts:809`)
   instead of a `PERSONA_AGENT` job, same-transaction CAS preserved (INV-7).
   Note the roadmap's sealed-`note` caveat: the note is model-authored text
   derived from sealed content; decide sealed-at-rest vs. accept-as-metadata
   before shipping (the workspace-ops leak framing in Part 2 §3 applies).
4. **D3 — external interjection carrier** (optional): `newMessagesSince` on
   the renew response, gated by a manifest capability flag; default remains
   `declaredUnsupported`.
5. **D4 — external supersede-rerun** (low): re-dispatch invocation with
   `rerunContext.cause` on referenced-message edit, or declare it.
6. **Doc fix**: flip the stale §1.5 digest row in the redesign doc.

# Part 2 — Design: opt-in workspace tools for the E2EE enclave

Product posture: Threa never decides what's sensitive. Default is off; the
owner turning it on is an informed acceptance that _the queries the agent
runs for you, and their results, transit the backend in the clear at
execution time_ — while traces, replies, and conversation content stay
sealed. The same consent gate must be the one that later admits external
bots to sealed streams (§2.6 of the redesign): one mechanism, not two.

## 2.1 Thesis

Workspace tools are excluded from the enclave at two layers today: assembly
(`buildEnclaveTools` never constructs them, `apps/enclave/src/agent/tools.ts:55-100`)
and category policy. Keep assembly as the structural gate for **writes**;
repurpose the per-stream category policy (`stream_policies.allowed_tool_categories`,
the §2.8-Q3 tracking table) as the **positive, per-stream owner grant** for
**reads**. When granted, the enclave executes Threa-managed workspace read
tools through one new session-bound callback; the durable trace stays sealed.

## 2.2 Consent & policy model

**The default problem.** Policy absence means "no restriction"
(`policy-repository.ts:18-25`; `areToolCategoriesAllowed` short-circuits
null→true, `tool-privacy.ts:117-125`). Harmless today only because the
enclave never builds workspace tools; the moment it can, a null policy would
silently grant them. So:

**Compute an explicit E2E floor at the claim seam** (`claim-service.ts:343`
where the policy is already fetched):

```
effectiveCategories = policy ?? (streamIsE2e ? ["web"] : null)
```

- Non-E2E streams keep null = unrestricted (companion unchanged).
- An E2E assignment **never** carries null/undefined categories — assert
  loudly (INV-11). Call it **INV-E-tool**: the backend never ships an absent
  tool policy into an E2E turn, and the enclave treats undefined-on-E2E as
  fail, not allow-all.
- `workspace` (later `github`/`linear`) is reachable in the enclave only when
  the owner explicitly added it — genuine opt-in, in the same array the
  existing picker writes.

**Consent UX** lives in the existing `ToolPolicyPicker`
(`tool-policy-picker.tsx:32-34,105`): move `workspace` out of the
"not in enclave / Soon" set and attach an E2E-conditioned disclosure to that
row (no layout shift, INV-21; no success toast, INV-63). Copy in the §1.6
honest-caveat register:

> Let Ariadne search your workspace from inside this encrypted scratchpad.
> Your messages and her replies stay end-to-end encrypted. The searches she
> runs and the results she reads pass through Threa's servers in the clear
> for that moment — they are not stored (her trace stays sealed), but they
> are briefly visible to the running backend. She can only reach content you
> already have access to, and never another encrypted scratchpad.

**Re-consent:** none needed on key roll (the leak is orthogonal to the SSK)
or membership change — but execution always scopes to the **triggering**
user (`listAccessibleStreamIds(pool, workspaceId, trigger.authorId)`,
`streams/access.ts:174`), exactly as the companion binds it
(`persona-agent.ts:506-512`), so a member's turn can never read beyond that
member's access regardless of who set the policy.

## 2.3 Wire & execution — one generic callback

The enclave is outbound-only. Rejected: per-tool bespoke endpoints (N
duplicates of `agents/tools/`, INV-35) and ship-in-assignment (workspace
search is query-dependent, decided mid-turn). **Recommended: one generic
execute callback** dispatching to the existing server-side tool registry.

`POST /internal/enclave-runtimes/sessions/:id/tools/execute` — mounted with
the other session callbacks (`routes.ts:345-354`), auth = `enclaveAuth` +
`assertCallbackBound`/`verifyCallbackToken` (`sealed-session-guards.ts:32-45`;
token minted at claim, `claim-service.ts:412-417`). Body (plaintext — the
disclosed leak): `{ name: AgentToolName, args }`, Zod-validated (INV-55).

Handler flow: `assertRunning` + callback binding → resolve stream/trigger →
**independently re-gate server-side**: recompute the E2E effective policy and
`isToolAllowedByPolicy`; 403 un-granted categories AND any `messaging`
(write) tool — the enclave-side `negotiateCapabilities` filter is UX, this
callback is the trust boundary → `listAccessibleStreamIds` scoped to
`trigger.authorId` → build `WorkspaceToolDeps` (`tool-deps.ts:7-16`) and call
the registry factory's `execute` → return `{ output, sources?, multimodal? }`.
INV-41/30: discrete request/response, `pool` passed directly, nothing held
across the model's in-enclave thinking.

Enclave side: `BackendCallbacks.executeWorkspaceTool` (same headers as
`pollMessages`); `buildEnclaveTools` constructs workspace read tools proxying
to it when `effectiveCategories` includes `workspace`; their trace steps seal
via `EnclaveSealingSink` exactly as web-tool steps do
(`trace-observer.ts:84-123`).

## 2.4 Exact leak surface (the consent copy's substance)

Becomes backend-visible, transiently, per call: tool name, model-authored
args (the search query, target stream, limits), the plaintext result (data
the invoking user already has access to — search partitions E2E streams out
pre-query, `search/service.ts:103-115`, so no cross-contamination of other
sealed streams), and precise timing. Stays sealed: conversation content,
replies, **all trace step content including the workspace tool's query and
result** (`agent_session_steps` remains ciphertext), summaries, digests,
titles, attachments. The §1.6 no-memory guarantee is untouched — every gate
keys off `isE2eStream`, and this adds no plaintext row to any pipeline.

**Logging caveat (load-bearing):** workspace tools log queries at debug
(`search-workspace-tool.ts:159,315,375,469`). Enclave-origin executions must
carry an `origin: "enclave-sealed"` flag through `WorkspaceToolDeps` that
suppresses arg/result content in logs — otherwise "sealed trace, cleartext
logs" makes the guarantee dishonest.

## 2.5 Writes

The opt-in grants **reads only**. Every `workspace`-category tool is
read-only (`tool-privacy.ts:61-67`). The `messaging` write tools
(`send_message`, `react_to_message`, `schedule_follow_up`) are always-allowed
by category (`tool-privacy.ts:46-55` — `messaging` bypasses policy), so they
must stay **structurally excluded at assembly** and **403'd at the callback**:

- The reply is not a tool — it commits sealed via `TurnSink.commitMessage`
  (`run-turn.ts:376-393`), INV-E1 satisfied. Unchanged.
- `schedule_follow_up`: OUT of this opt-in — plaintext `note` at rest derived
  from sealed content + a plaintext companion fire path violate the spirit of
  INV-E1; it needs its own sealed design (Part 1 §1.5 item 3).
- `react_to_message`: OUT of scope; if ever wired, scope to the current
  stream and treat as participation, not this read grant.

Guard test: assert `buildEnclaveTools` never constructs a `messaging`-category
tool regardless of policy (mirrors the `satisfies` exhaustiveness discipline
at `tool-privacy.ts:84`).

## 2.6 One gate for the future external case

Unify the two dispatch decisions — _may this actor receive a sealed turn_
(`resolveDeliveryVerdict`) and _which categories does it get_ — into one
resolver consumed at the claim seam:

```
resolveE2eAgentPolicy({ streamIsE2e, trust, actorHasGrant,
                        externalSealedDelivery, streamPolicy })
  -> { delivery: "plaintext" | "sealed" | "denied",
       effectiveCategories: ToolPrivacyCategory[] }
```

Today: enclave = `FIRST_PARTY_ATTESTED` + automatic grant → sealed, with the
owner's floor-adjusted categories. Tomorrow: an owner-invited BIK bot =
`THIRD_PARTY` + grant + `EXTERNAL_SEALED_DELIVERY` flipped → sealed through
the same function, same category array, same picker. Execution transport
still differs by driver (the enclave proxies Threa tools; a self-driven bot
brings its own and Threa doesn't proxy its calls) — the §2.2 "tier governs
what may be minted; driver governs what it carries" split, honored.

## 2.7 Phases

1. **PR1 — E2E policy floor** (safety, no user-visible behavior): explicit
   categories on every E2E assignment + INV-E-tool assertion + enclave
   fail-on-undefined. Tests: null policy → `["web"]`; explicit passthrough;
   non-E2E unchanged.
2. **PR2 — generic execute callback** (unused yet): auth, server re-gate,
   write-403, trigger-scoped access, log scrub. Tests: token/403/409 matrix,
   messaging-tool 403, scoping, no query content at info-level logs.
3. **PR3 — enclave proxies workspace reads**: `executeWorkspaceTool`,
   conditional assembly, sealed steps. Tests: present iff granted; output
   parity with companion `search_messages`; step ciphertext-only.
4. **PR4 — consent UX**: picker + disclosure. Tests mount the real component
   (INV-39); INV-63 guard stays green.
5. **PR5 — unified resolver** (`resolveE2eAgentPolicy`): enclave verdict
   unchanged pre/post; external still denied while the switch is off; a
   granted+flipped hypothetical resolves sealed with the owner's categories.

# Part 3 — Design: the BYOA SDK (`@threa/bot`)

## 3.1 Current-state verdict

`extensions/bot-runtime-client` is **~25% of an SDK — the hard 25%**. It owns
the `/bot` socket, hello + bootstrap cursor, reconnect/backoff, WS-first
hot-path writes with the `sent:false` (retry-safe) vs `sent:true, ack:null`
(best-effort) distinction, and lease-safe HTTP-fallback renew
(`transport.ts:101-304`). It deliberately does not own claim/complete/fail/
sessions — so every harness hand-rolls them:

- Three HTTP clients: pi-remote `request()` (`threa-remote.ts:516`),
  claude-code-remote `ThreaClient` (`threa-client.ts:70-175`), harness-daemon
  raw `fetch` (`spawners.ts:134-153`).
- Two **disagreeing** `ClaimedInvocation` types (`threa-remote.ts:109-120`
  vs `threa-client.ts:34-52`) — no canonical wire type for the claim
  response exists in `packages/types` at all.
- Duplicated: instanceId sanitize/stable-derivation (verbatim copy in
  harness-daemon), claim loop + renew timer, the "always send full
  capabilities or the server wipes them" presence gotcha (independently
  discovered and commented in both harnesses), graceful shutdown.
- pi-remote still pays a per-invocation `GET /streams/:id/messages`
  (`threa-remote.ts:1319-1347`) for history the claim now returns inline.
- Everything is `private: true` pointing at raw `.ts`, installed via the
  `install-local.ts` vendoring hack — nothing a non-Threa developer can
  `bun add`.

## 3.2 The surface

**Factory + callbacks, not a subclass.** The harness owns the process and the
agent; the SDK is a guest (INV-13: one long-lived object). One required
callback:

```ts
import { createThreaBot } from "@threa/bot"

const bot = createThreaBot({
  token: process.env.THREA_BOT_KEY!,
  runtimeKind: "custom",
  instanceId: "echo-1",
  capabilities: ["mentionable"],
  onTurn: async (turn) => turn.reply(`You said: ${turn.prompt}`),
})
await bot.start()
```

That is the entire echo bot. `onTurn(turn)` receives
`{ prompt, trigger, context (inline history), stream, session, can, signal }`
plus verbs `postStep / reply / noResponse / fail`. Claim renewal is an
SDK-owned timer cleared on completion (escape hatch `renew: "manual"`); a
thrown `onTurn` auto-`fail`s with the normalized, 1000-char-capped error;
`turn.signal` fires on stop/claim loss. Optional callbacks
(`onSessionControl`, `onActiveActorChanged`, `onResync`) default inside the
SDK; `bot.ensureSession(...)` wraps the session create/link/rebind flow all
three harnesses reimplement, aware of per-kind `sessionLinking` policy
(`runtime-kind-config.ts:22-36`). The raw transport stays exported for anyone
who needs to go under the SDK.

Pi-shaped harnesses drive the same handle imperatively: seed from
`turn.context` (deleting the extra GET), stream `postStep`s from their own
loop, `reply({ markdown, sources })` at the end, actuate `onSessionControl`
(`stop` → interrupt, `steer` → inject) while the SDK claims/completes the
control invocation.

## 3.3 Types & publishing

Zero wire types declared in `extensions/` (INV-31/33/35). Promote
`ClaimedInvocation`, `ExternalHistoryMessage`, and
`TurnContext = { kind: "inline", … } | { kind: "sealed", sealed: SealedTurnContext }`
into `packages/types`; request bodies come from the public-api Zod schemas'
inferred types; extend `ws-http-schema-parity.test.ts` to pin the SDK's
imports. Publish `@threa/bot` (dist ESM + `.d.ts`, `socket.io-client` as
peer) with a pruned `@threa/types/bot` entrypoint. **The redesign's deferred
`taipVersion` becomes due exactly at first npm publish** — the first
skew-capable consumer; the SDK sends a `WIRE_VERSION` on `bot:hello`
(additive) from day one.

## 3.4 What the SDK must NOT do

Drive the model, own the loop's content, decide when a turn is done, invent a
cancellation route the backend doesn't have, or ship sealed turns while
`EXTERNAL_SEALED_DELIVERY = false` — but the `TurnContext` union keeps the
wire sealed-ready per §2.6 rule 1, so the flip is zero SDK API change.

## 3.5 Phases

0. **Shared types** in `packages/types` — kills the `ClaimedInvocation` drift
   immediately; both harnesses import instead of redeclaring. 1 small PR.
1. **`ThreaHttpClient`** in the kit; migrate claude-code-remote (deletes
   `ThreaClient`, ~175 LOC) and harness-daemon's fetch.
2. **`createThreaBot` + `Turn`** — the "stupid simple" milestone. Ships the
   9-line echo example + the getting-started doc (the WS half of the protocol
   is currently documented nowhere externally).
3. **Migrate pi-remote then claude-code-remote** onto it: ~1,000–1,300 LOC of
   thrice-duplicated protocol code deleted; harness-specific actuation
   (native session vs tmux), redaction, and config stay put.
4. **Publish to npm** + `taipVersion` negotiation server-side.
5. **(Gated)** sealed delivery — activates the `{kind:"sealed"}` arm when the
   policy flips; no author-facing change.

Prerequisite bug fix (before or during Phase 1): D2 rebind (Part 1 §1.5.1) —
the SDK's `ensureSession` would otherwise inherit a path that 404s for every
non-Pi stateful harness.
