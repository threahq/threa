# Design Doc: Trust Tiers & Per-Runner Identity (Phase 2.4)

**Status:** proposal — review before implementation
**Audience:** engineering
**Related:** `docs/plans/agent-runtimes-unification-redesign.md` (§2.2.3, §2.4 row 2.4, §2.6, §2.7), `docs/plans/agent-runtime-pluggability.md` (§5.4), `docs/audits/e2ee-enclave-audit-2026-06.md` (E2EE-7, E2EE-21, E2EE-22)
**Scope anchor (authoritative):** §2.4 row 2.4 — "Trust-tier rule in `negotiateCapabilities` replaces scattered E2E guards; per-runner identity + real attestation before the tier is load-bearing" (E2EE-21/22 precondition)

## 0. TL;DR

Phase 2.4 has two halves that the phase-table row deliberately couples:

1. **The declarative gate.** One pure rule — grown into the existing
   `negotiateCapabilities` chokepoint
   (`packages/agent-runtime/src/runtime/negotiate-capabilities.ts:28-31`) —
   computes the single permitted payload delivery (`plaintext` / `sealed` /
   `denied`) for an actor on a stream from three inputs: the actor's
   **host-assigned trust tier**, the stream's E2E status, and the actor's
   **live key grant** (`e2e_stream_actors` + live wrapped instances). The four
   agent-dispatch guard sites stop encoding the policy inline and start
   comparing their driver's capability against the verdict. The rule is the
   redesign's **key-grant formulation** ("no live, explicitly granted SSK wrap
   for this actor ⇒ no sealed delivery"), not the pluggability doc's
   "third-party ⇒ never sealed" hard gate — so E2EE-for-external-agents stays
   a policy flip (`externalSealedDelivery`, off), not a redesign.
2. **The identity work that makes the tier true.** Today any
   `INTERNAL_API_KEY` holder can register an EIK, receive SSK wraps, and
   complete another instance's session (E2EE-21/22) — so a
   `first-party-attested` answer from the gate would be policy theater. The
   fix ports the auth shape the **bot path already proved**: per-invocation
   claim tokens with row-bound validation
   (`bot-runtimes/repository.ts:613-677`). Sessions get a dispatch-minted
   callback token + `serverId` binding + reply-generation sanity (closes
   E2EE-21); enclave registration gets a dedicated credential and a
   wrap-eligibility rule (closes E2EE-22's actionable half; TEE attestation is
   an explicitly documented upgrade path, not built here).

Sub-PRs: **2.4a** (tier vocabulary + verdict rule + guard fold), **2.4b**
(session-bound callbacks, E2EE-21), **2.4c** (registration credential +
wrap eligibility, E2EE-22). 2.4a is independent; 2.4b/c are independent of
2.4a and of each other.

Nothing here flips `externalSealedDelivery`, builds sealed bot wire variants,
or adds consent UX — those stay deferred per redesign §2.6.

## 1. Why the row couples the gate to identity

The gate consolidates _policy_; identity makes the policy _enforceable_. They
fail differently when shipped alone:

- **Gate without identity:** `negotiateCapabilities` answers "sealed delivery:
  granted" for the enclave because its tier is `first-party-attested` — but
  the tier rests on a secret shared with every internal consumer
  (`createInternalAuthMiddleware`, applied to all `/internal/enclave-runtimes/*`
  routes at `apps/backend/src/routes.ts:279-309`). The audit's words: "Any
  internal-key holder (e.g. the bot-runtime, which holds the same key) can
  register a key and become an SSK recipient" (E2EE-22). The gate would be
  honest about policy and dishonest about trust.
- **Identity without the gate:** the guards stay scattered
  (§2.1 below), so the next surface (sealed external delivery, a new persona,
  a new dispatch path) re-derives the rule ad hoc — the exact drift the
  unification exists to stop.

Sequencing consequence: 2.4a may land first, but until 2.4b/c land the tier
assignment is **operational, not adversarial** — the same caveat the redesign
already states in §1.6 ("'Only the enclave' is operational, not attested").
The doc-level invariant: every place the tier vocabulary is introduced carries
this caveat until E2EE-21/22 are closed.

## 2. Ground truth (audited 2026-06-12, main @ 65f5466)

### 2.1 The guards today — what folds, what stays

The full sweep found ~20 `isE2eStream`-shaped branches. They split cleanly by
intent.

**Fold candidates — agent-dispatch decisions** (these encode "may this actor
take this turn / receive this payload", i.e. the verdict):

| Site                                                       | Today                                          | Under the rule                                                           |
| ---------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `agents/companion-outbox-handler.ts:116`                   | skip E2E streams (companion is plaintext)      | verdict ≠ `plaintext` ⇒ skip                                             |
| `enclave-runtimes/dispatch/enclave-dispatch-handler.ts:90` | only E2E streams (enclave is sealed)           | verdict ≠ `sealed` ⇒ skip                                                |
| `bot-runtimes/invocation-outbox-handler.ts:102`            | **silent** `return` for E2E streams            | verdict `denied`/`sealed` ⇒ skip with structured reason + telemetry      |
| `enclave-runtimes/dispatch/enclave-invoke-worker.ts:100`   | `isE2eCapablePersona` inline check             | persona capability folds into the actor's manifest consulted by the rule |
| `public-api/handlers.ts:389` (2.3d's `buildClaimContext`)  | inline `stream.e2eEnabled === true ⇒ withhold` | consult the same verdict predicate                                       |

**Backstops — stay in place, become unreachable-by-design** (defense in depth
for INV-E1; the gate makes the rejected requests impossible to mint, the sink
still refuses them):

- `public-api/handlers.ts:586` `assertNotE2eStream` (sendMessage /
  updateMessage / completeBotInvocation)
- `messaging/handlers.ts:290-298` + `messaging/event-service.ts:331-355`
  (`assertE2eContentMatch` — the plaintext/ciphertext mismatch sinks)

**Out of scope — different reasons, not this rule:**

- Plaintext-consumer skips (server cannot read ciphertext): search
  (`search/service.ts:103-111`), auto-naming, emoji usage, link previews,
  boundary extraction, memo accumulation/embedding,
  `agents/message-mutation-outbox-handler.ts:196`.
- `agents/mention-invoke-outbox-handler.ts:113`: persona mentions ride in
  ciphertext and are invisible to the server — a _trigger-visibility_
  constraint (redesign §2.6 rule 5), not a trust decision.
- Server-can-never-seal refusals: scheduled messages
  (`scheduled-messages/service.ts:653-657`), sharing boundary
  (`messaging/sharing/service.ts:224-226`).

`negotiateCapabilities` already has exactly the right callers for the tool
half: `agents/persona-agent.ts:539,578` (companion + enclave share the loop)
and `apps/enclave/src/agent/tools.ts:45` — the chokepoint exists; 2.4 grows
what it answers.

### 2.2 Identity today — the asymmetry the design exploits

The two runner populations have opposite auth maturity:

|                  | Enclave → backend                                                                                                                                                                         | External bot → backend                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential       | `INTERNAL_API_KEY`, shared with every internal consumer                                                                                                                                   | per-bot `threa_bk_*` API key, hash + `timingSafeEqual` (`public-api/bot-api-key-service.ts:146-171`)                                                                            |
| Instance binding | none — `session.serverId` (the EIK keyId, `agents/session-repository.ts:23,67`) is stored at dispatch, **never validated on callback** (`session-handlers.ts:206-207` checks only status) | `claimed_by_instance_id` in the claim row                                                                                                                                       |
| Turn binding     | none — any key holder can `/steps`, `/complete`, `/fail` any running session                                                                                                              | `claim_token` (randomUUID, `public-api/handlers.ts:951`) validated in the mutation `WHERE` clause with workspace, bot, instance, and TTL (`bot-runtimes/repository.ts:613-677`) |
| Payload sanity   | reply envelope `keyGeneration` never checked — a wrong-generation seal persists as a permanently undecryptable message (E2EE-21)                                                          | n/a (plaintext)                                                                                                                                                                 |

Registration (`apps/enclave/src/register.ts:13-32` →
`enclave-runtimes/repository.ts:62-73`, upsert `ON CONFLICT (key_id)`)
presents an X25519 EIK and an instance URL — no attestation evidence.
`/attestation` (`apps/enclave/src/index.ts:38-43`) returns build metadata that
**no backend code consumes**. Owner clients wrap the stream key to **every
live EIK** (`streams/service.ts:891-926` `resolveActorRecipients` →
`EnclaveRuntimesRepository.listLive`). Verbatim audit findings: E2EE-21,
E2EE-22 in `docs/audits/e2ee-enclave-audit-2026-06.md`.

The design consequence: **E2EE-21 is not a research problem — it's a port.**
The claim-token shape on the bot path is the exact per-turn binding the
enclave callbacks lack, and the §2.7 pull inversion (deferred Phase 2.2
transport work) would converge the enclave onto that very claim protocol
anyway. 2.4b builds the binding so it transfers (a callback token _is_ a
claim token under pull).

### 2.3 The key-grant data is real, not speculative

The rule's `actorHasLiveWrap` input reads infrastructure that already exists
and is tested:

- BIK registration at `bot:hello` (`bot-runtimes/socket-handler.ts:26-62`,
  both-or-neither validation; columns from migration
  `20260529044304_bot_runtime_identity_key.sql`).
- `e2e_stream_actors` pins invited actors to concrete principals — PK
  `(workspace_id, stream_id, kind, actor_id)`, `kind ∈ {enclave, bot}`
  (migrations `20260528130000`, `20260529061739`).
- Owner-minted SSK wraps resolve per pinned `actor_id` and re-wrap on every
  key roll (`streams/service.ts:891-926`, roll procedure `:942-1040`).

So "does this actor hold a live grant on this stream" is a query, today, with
test coverage (`streams/service.test.ts:675-695,788-849`). What does **not**
exist is the sealed wire for bots (no sealed claim payload, `/steps`,
`/complete`) and any consent UX beyond the invite button — both stay
deferred; the rule must merely not foreclose them.

## 3. The gate (2.4a)

### 3.1 Trust tier: host-assigned, never wire-declared

```ts
export type TrustTier = "first-party-inproc" | "first-party-attested" | "third-party"
```

The tier is a property of the **authentication channel**, derived server-side:

| Actor             | Channel                                                | Tier                   |
| ----------------- | ------------------------------------------------------ | ---------------------- |
| Companion persona | in-process construction (no wire)                      | `first-party-inproc`   |
| Enclave runtime   | enclave registration path (2.4c: dedicated credential) | `first-party-attested` |
| External bot      | `threa_bk_*` public-API key                            | `third-party`          |

This refines the pluggability sketch, which placed `trust` on the
`CapabilityManifest`. A manifest is a **runner's claim** (it arrives in
`bot:hello`); the tier gates key material, so it must come from how the host
authenticated the actor, not from what the actor said — the pluggability doc
itself flags manifest fields as "a CLAIM; the host verifies against trust
tier". Concretely: the tier never crosses the wire, never appears in
`bot:hello` or the persisted `manifest` column (2.3b), and is assigned at the
dispatch site from what kind of actor is being dispatched. The manifest keeps
what it has — claims about the runner's own _behavior_ (`output`, triggers),
enforced by `assertManifestAllows`.

`first-party-attested` is aspirational until 2.4b/c land (§1); see Open-Q1 on
whether to carry the honest name from day one.

### 3.2 The delivery verdict — key-grant rule, one function

Where the two prior docs disagree, the redesign wins (its own preamble says
so): the rule is **not** "third-party ⇒ never sealed". It is:

> No live, explicitly granted SSK wrap for this actor ⇒ no sealed delivery —
> key possession via grant, evaluated in one place, with the
> `externalSealedDelivery` policy switch (off today) inside the same gate.

Grown signature (sketch — final shapes at implementation):

```ts
export interface SealingContext {
  streamIsE2e: boolean
  /** Resolved by the caller: e2e_stream_actors row for this actor with a
   *  live, keyed instance to wrap to (enclave EIK or bot BIK). */
  actorHasLiveGrant: boolean
  /** Global policy switch for sealed delivery to third-party actors.
   *  Hardcoded false today; flipping it is the §2.6 one-line change. */
  externalSealedDelivery: boolean
}

export type DeliveryVerdict =
  | { delivery: "plaintext" }
  | { delivery: "sealed" }
  | { delivery: "denied"; reason: "no-key-grant" | "sealed-policy-disabled" }

export interface NegotiateCapabilitiesParams {
  trust: TrustTier
  sealing: SealingContext
  streamPolicy: ToolPrivacyCategory[] | null | undefined
  tools: AgentTool[]
}

export interface NegotiatedCapabilities {
  tools: AgentTool[]
  verdict: DeliveryVerdict
}
```

The verdict logic, exhaustively:

1. `!streamIsE2e` ⇒ `plaintext`. (Third-party actors pass — today's working
   path, untouched.)
2. `streamIsE2e && !actorHasLiveGrant` ⇒ `denied("no-key-grant")`. Plaintext
   into an E2E stream is never mintable for anyone — this is INV-E1 expressed
   at dispatch time, and it is why the companion never takes an E2E turn (the
   companion actor holds no wrap by construction).
3. `streamIsE2e && actorHasLiveGrant && trust !== "third-party"` ⇒ `sealed`
   (the enclave's grant is automatic at E2E-stream creation).
4. `streamIsE2e && actorHasLiveGrant && trust === "third-party"` ⇒
   `externalSealedDelivery ? sealed : denied("sealed-policy-disabled")`.

Two properties worth naming. _Tier governs what may be minted; the driver
governs what it can carry_ — each dispatch site compares the verdict against
its driver (`companion: plaintext`, `enclave: sealed`, `external: plaintext`
today) and skips on mismatch, so the **routing pair** in §2.1 becomes two
sites consuming one rule rather than two complementary inline predicates.
And _flipping `externalSealedDelivery` changes only branch 4_ — an invited,
BIK-bearing bot starts receiving `sealed` verdicts, every downstream path
already type-checks, and what's missing is purely the sealed wire + consent
UX (deferred, by design).

### 3.3 Placement and purity

`negotiateCapabilities` stays a **pure function** in
`packages/agent-runtime/src/runtime/` — it cannot query Postgres, and that's
the point (it's shared with the enclave build). Callers resolve the
DB-backed inputs, exactly as they do for `streamPolicy` today:

- New backend resolver `resolveSealingContext(db, { workspaceId, streamId,
actor })` lives in `apps/backend/src/features/e2e-streams/` (the data owner
  of `e2e_streams` + `e2e_stream_actors`), exported via the barrel (INV-52).
  It answers `streamIsE2e` and `actorHasLiveGrant` in one or two set-based
  queries (INV-56), reusing the staleness rules `resolveActorRecipients`
  already encodes.
- The enclave keeps receiving its inputs in the assignment (it already gets
  `allowedToolCategories`); nothing new crosses that wire in 2.4a.

### 3.4 Loud vs silent at the fold sites

`denied` is a structured verdict, not an exception — outbox dispatch sites
_skip_ (an undispatchable turn is not an error), but the skip now carries the
reason into logs/telemetry instead of a bare `return`
(`invocation-outbox-handler.ts:102` is the offender this fixes). No
user-visible denial UX in 2.4: the server cannot render plaintext rows into
an E2E timeline, and client-side affordances are a separate product decision.
Verb handlers that _receive_ an impossible request (e.g. a bot completing
into an E2E stream) keep throwing via the existing backstops.

## 4. Per-runner identity (2.4b, 2.4c)

### 4.1 E2EE-21 — session-bound callbacks (2.4b)

Port the bot claim-token model to enclave sessions:

1. **Mint at dispatch.** The enclave invoke worker generates a
   `callbackToken` (randomUUID) when building the assignment; it is stored
   on the session row alongside the existing `server_id` and carried in
   `EnclaveSessionAssignment` (additive field in `packages/types`).
2. **Echo on every callback.** The enclave includes the token (header) on
   `/messages`, `/steps`, `/steps/started`, `/substeps`, `/complete`,
   `/fail`, `/sealed-name`, session heartbeat — one place in
   `apps/enclave/src/agent/backend-callbacks.ts:44-49` where the shared key
   header is already attached.
3. **Validate in the row predicate.** Session callback handlers validate
   `(sessionId, callbackToken, serverId)` the way the bot repo does — in the
   `WHERE` clause of the mutation, not as a separate read (INV-20). A
   mismatch is a loud 403, telemetry-tagged.
4. **Reply-generation sanity** (the finding's second half): `/messages` and
   `/steps` reject a sealed payload whose envelope `keyGeneration` differs
   from the generation the assignment told the enclave to seal under
   (recorded on the session at dispatch). Today a wrong-generation seal
   persists as a permanently undecryptable reply; after 2.4b it fails the
   turn loudly instead.

**Rollout:** two steps to avoid bricking in-flight sessions — first deploy
mints + echoes + validates-if-present; once both sides are out, enforcement
flips to reject-if-absent for sessions that have a token. Sessions created
before the first deploy have `callback_token IS NULL` and are exempt by the
same predicate.

**Forward-compatibility:** under the §2.7 pull inversion (deferred), the
callback token _is_ the claim token — `claim → heartbeat/poll →
complete/fail` with the identical row-bound predicate. Nothing in 2.4b is
throwaway; it is the push-era spelling of the binding pull gets for free.

### 4.2 E2EE-22 — registration credential + wrap eligibility (2.4c)

The finding offers two closures: "verify attestation at registration or
document explicitly that enclave identity rests on `INTERNAL_API_KEY`
secrecy." The current deployment has no TEE, so _verifying_ attestation
evidence is not buildable today; 2.4c does the strongest things that are:

1. **Credential separation.** Enclave registration and session callbacks
   authenticate with a dedicated secret (`ENCLAVE_INTERNAL_API_KEY`),
   distinct from the `INTERNAL_API_KEY` other internal consumers hold. This
   directly kills the named vector ("the bot-runtime, which holds the same
   key, can register a key and become an SSK recipient"). Config flows
   through constructed dependencies (INV-12); both keys validated by the same
   middleware factory with different values.
2. **Wrap eligibility follows the credential.** `resolveActorRecipients`'s
   enclave branch wraps to every live row in `enclave_runtimes`; after
   separation, rows can only be created by holders of the enclave credential,
   so wrap eligibility inherits the boundary without a schema change.
3. **The attestation posture is documented, deliberately.** Enclave identity
   rests on `ENCLAVE_INTERNAL_API_KEY` secrecy plus the registration path —
   stated in `docs/features/architecture/e2e-enclave.md` and beside the tier
   derivation, satisfying the finding's "document explicitly" arm. Real TEE
   evidence (e.g. a Nitro/TDX document binding the EIK public key) slots into
   the registration handler when the infrastructure exists; we do **not**
   build a verifier interface, an `attestation_status` column, or any other
   speculative seam ahead of that day (INV-36) — the registration handler is
   the seam.

### 4.3 Deliberately out of scope

TEE integration itself; flipping `externalSealedDelivery`; sealed
claim/`/steps`/`/complete` wire variants for bots; consent/revocation UX for
E2E actor grants; E2EE-7 (old-generation re-wrap on revive — a parked-turn
recovery bug, orthogonal to trust); the §2.7 pull transport.

## 5. File-by-file change list (interfaces/signatures only)

| File                                                                                                                                                                                             | Change                                                                                                    | Sub-PR |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------ |
| `packages/agent-runtime/src/runtime/negotiate-capabilities.ts`                                                                                                                                   | `TrustTier`, `SealingContext`, `DeliveryVerdict`; params gain `trust` + `sealing`; result gains `verdict` | 2.4a   |
| `packages/agent-runtime/src/{index,runtime/index}.ts`                                                                                                                                            | barrel exports                                                                                            | 2.4a   |
| `apps/backend/src/features/e2e-streams/{sealing-context.ts,index.ts}`                                                                                                                            | new `resolveSealingContext`; barrel export                                                                | 2.4a   |
| `agents/companion-outbox-handler.ts`, `enclave-runtimes/dispatch/enclave-dispatch-handler.ts`, `bot-runtimes/invocation-outbox-handler.ts`, `enclave-runtimes/dispatch/enclave-invoke-worker.ts` | inline E2E predicates → verdict consumption (+ structured skip telemetry)                                 | 2.4a   |
| `public-api/handlers.ts` (`buildClaimContext`)                                                                                                                                                   | E2E withhold consults the shared predicate                                                                | 2.4a   |
| `agents/session-repository.ts` + migration                                                                                                                                                       | `callback_token` column on `agent_sessions` (append-only, INV-17)                                         | 2.4b   |
| `packages/types/src/api.ts` (`EnclaveSessionAssignment`)                                                                                                                                         | additive `callbackToken`, `replyKeyGeneration` already present via `reply.keyGeneration`                  | 2.4b   |
| `enclave-runtimes/dispatch/enclave-invoke-worker.ts`, `request-builder.ts`                                                                                                                       | mint + persist token; record reply generation for sanity check                                            | 2.4b   |
| `enclave-runtimes/session-handlers.ts`                                                                                                                                                           | row-bound `(sessionId, token, serverId)` validation; generation sanity rejection                          | 2.4b   |
| `apps/enclave/src/agent/backend-callbacks.ts`, `config.ts`                                                                                                                                       | echo token header                                                                                         | 2.4b   |
| `apps/backend/src/routes.ts`, `enclave-runtimes/handlers.ts`, `apps/enclave/src/{register,config}.ts`                                                                                            | dedicated `ENCLAVE_INTERNAL_API_KEY` on registration + callbacks                                          | 2.4c   |
| `docs/features/architecture/e2e-enclave.md`                                                                                                                                                      | documented identity posture                                                                               | 2.4c   |

## 6. Test plan

- **Verdict matrix** (`negotiate-capabilities.test.ts`): every
  `tier × streamIsE2e × actorHasLiveGrant × externalSealedDelivery`
  combination asserts the exact verdict object (INV-24) — including the two
  load-bearing pins: third-party + grant + policy-off ⇒
  `denied("sealed-policy-disabled")` (the one-line-flip property), and
  E2E + no grant ⇒ `denied("no-key-grant")` for every tier.
- **Fold regressions:** bot invocation into an E2E stream is still not
  dispatched (the silent-skip behavior preserved, now with reason); companion
  and enclave routing behavior is byte-identical on both stream kinds; 2.3d's
  claim-context E2E withhold keeps its existing regression test green.
- **Callback binding (2.4b):** wrong/missing token ⇒ 403 and no row mutated;
  token from session A replayed against session B ⇒ rejected by the row
  predicate; pre-rollout sessions (`callback_token IS NULL`) unaffected;
  wrong-generation sealed reply ⇒ loud failure, no undecryptable message
  persisted (the E2EE-21 regression).
- **Credential separation (2.4c):** old shared key on enclave routes ⇒ 401;
  enclave credential on non-enclave internal routes ⇒ 401; registration under
  the enclave credential still upserts and heartbeats.
- Suites: `bun test` from repo root for `packages/agent-runtime`; backend
  feature suites in `apps/backend`; enclave is vitest (`bun run test` from
  `apps/enclave`).

## 7. Decisions bound here (do not relitigate downstream)

- Key-grant formulation over the hard third-party gate (redesign §2.2.3 over
  pluggability §5.4; the redesign is current where they disagree).
- Tier is host-assigned from the authentication channel; it never crosses the
  wire and never lives on the manifest.
- `denied` is a structured skip at dispatch, a thrown error at verb handlers.
- 2.4b uses the claim-token shape so it survives the §2.7 pull inversion.
- No attestation verifier seam ahead of TEE infrastructure — the documented
  posture is the E2EE-22 closure for now.

## 8. Open items to resolve before coding

1. **Tier naming honesty (Open-Q1):** keep `first-party-attested` from day
   one (with the §1 caveat documented at the derivation site), or introduce
   it as `first-party-enclave` and rename when attestation is real? Leaning:
   keep the redesign's name, document the caveat — a later rename is exactly
   the churn INV-49 exists to avoid.
2. **`callback_token` placement:** column on `agent_sessions` (the turn
   record — proposed) vs. a separate tracking table (INV-57 reads either way:
   the token is turn-scoped state and the session row _is_ the turn's
   tracking row). Decide at 2.4b review.
3. **Does 2.4a also pass `trust` into the tool fold?** The tool half of
   `negotiateCapabilities` currently ignores tier; nothing requires
   tier-gated tools yet (INV-36 says don't invent one). Proposed: the
   parameter exists (the verdict needs it), the tool filter keeps ignoring it
   until a real tier-gated tool appears.
4. **Telemetry shape for `denied` skips:** counter + structured log vs. an
   outbox-visible event. Proposed: log + metric only; no timeline surface.
