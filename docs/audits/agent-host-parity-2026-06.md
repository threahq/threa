# Agent Host Parity Audit — June 2026

- **Date:** 2026-06-05
- **Code state:** branch `improve-e2ee`, even with `origin/main` @ `39df1ffa`; updated for `c8543af3` (#793) below.
- **Method:** two multi-agent workflows. (1) Claim verification of `docs/plans/agent-runtime-pluggability.md` — 9 claim-cluster verifiers, every non-confirmed verdict adversarially re-checked, plus a Steps 1–3 build-readiness assessment (run `wf_ab425350-0b1`, 24 agents). (2) Parity matrix — 11 dimension mappers + completeness critic (4 extra dimensions) + dedup/synthesis (run `wf_04d37ef9-9fa`, 17 agents, 159 capability rows). Every cell cites current-tree `file:line` evidence.
- **Goal (product owner):** full feature parity among the three agent hosts — public API, encryption, scope management, session handling.
- Reference new findings as `PARITY-<n>`; existing audit/plan ids (`E2EE-*`, `UX-*`, `#N`) are reused where the gap was already documented.

## The three hosts

|                 | Companion                 | Enclave                                          | External (plugin bots)                               |
| --------------- | ------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| What            | Native in-process Ariadne | E2EE Ariadne via attested-ish enclave            | Third-party harness (Pi, OpenClaw, …)                |
| Loop            | `AgentRuntime` (shared)   | same `AgentRuntime` via curated barrel           | **own loop** — five-verb protocol                    |
| Streams         | non-E2E only              | E2E only                                         | non-E2E only (hard-blocked from E2E)                 |
| Lifecycle table | `agent_sessions`          | `agent_sessions` (split machine over HTTP)       | `bot_invocations` + thin `agent_sessions` projection |
| Auth            | none (trusted server)     | shared `INTERNAL_API_KEY`, workspace-blind route | per-bot `threa_bk_*` keys + scopes                   |

The key structural fact: the three trigger predicates are **mutually exclusive on E2E-ness**. "Parity" is therefore really: companion is the non-E2E baseline, enclave is its E2E mirror, external is the plugin path overlapping companion. Where physics forbids parity (the enclave cannot reach plaintext DB; external runs its own model), the goal becomes _declared, loud degradation_ rather than silent absence.

## Part 1 — Verification of `agent-runtime-pluggability.md`

**Verdict: trustworthy.** All ~50 substantive claims confirmed against this tree (line numbers drift slightly; symbols and behavior hold). The drift symptoms (E2EE-9, E2EE-14, UX-12, #4, #5, #8, #6, #9), the dead `isToolAllowedByPolicy` gate, the three gating models, the three lifecycle machines, the Pi-isms, and the bot-runtimes five-verb protocol are all real and current.

**Corrections that change the build plan:**

1. **"Partly built on this branch" is false.** The merged attachments work (#765/#766/#778) is _inbound_ multimodal (enclave reading decrypted files). Migration Steps 1–5 are 0% built. Start from scratch.
2. **Step 1 cannot add `sources` to `EnclaveSealedReply`.** That is a cleartext wire field; E2EE-9's own design constraint forbids it (sources reveal what was researched). Sources must extend `E2eSealedPayload` in `@threa/crypto` and ride inside the ciphertext — a shared-package change touching the frontend decrypt path (`message-envelope.ts`) too.
3. **Step 1's "required multimodal" is speculative.** No outbound-multimodal-on-commit exists in any host (`sendMessage` carries only `content` + `sources?`). Dropped per INV-36.
4. **A fourth trace divergence:** the enclave observer also drops `context:received` via the event path (synthesized out-of-band by `emitContext`, `run-turn.ts:236-238`). The shared mapper must own it so Step 4 folds in.
5. Minor: the `/steps` bot handler is at `public-api/handlers.ts:1005` (not ~:546); `assertNotE2eStream` has three call-sites + one definition (not four call-sites).

**Already fixed on this tree (audit findings now closed):** E2EE-1/2/3/5 (INV-E1 sink guard, `event-service.ts:331-354` + edit rejection), E2EE-11 (bot-invocation E2E short-circuit, `invocation-outbox-handler.ts:96-97`), UX-7 (enclave prompt names its limits, `enclave-system-prompt.ts:79-83`), UX-35, UX-38. **Still open:** E2EE-7/8/9/10/14/17/18/20/21/22/23/25, UX-12, and the Part II UX clusters.

**Closed after the matrix ran** by `c8543af3` (#793): threads under an E2E scratchpad now inherit the root's E2E state (SSK, wraps, actors), and the enclave dispatch gates on the scratchpad's companion mode with root resolution for threads — closing the matrix's "thread inheritance: enclave missing" row and substantially narrowing the "three activation models" divergence (the enclave now honors the same Companion/Quiet toggle as the companion; it still additionally requires the invited enclave actor, and persona selection remains Ariadne-only / PARITY-6).

## Part 2 — Parity scores (vs companion baseline)

| Dimension                    | Enclave                               | External                               |
| ---------------------------- | ------------------------------------- | -------------------------------------- |
| Triggers & invocation        | ~55%                                  | ~50%                                   |
| Session handling & lifecycle | ~70%                                  | ~60%                                   |
| Tools & scope gating         | **~15%** (a ~4-tool agent vs ~30)     | ~30% (different axis: REST self-serve) |
| Context & input              | ~45% (role+markdown only)             | **~10%** (promptMarkdown only)         |
| Output capabilities          | ~60%                                  | ~45% (single plaintext reply)          |
| Steering/interjection/abort  | ~50%                                  | ~20%                                   |
| Encryption participation     | (the baseline)                        | ~5% (wrap plumbing half-built, unused) |
| Public API & auth            | ~40% (workspace-blind internal route) | ~75% (richest auth)                    |
| Observability & cost         | ~45%                                  | ~40%                                   |
| Frontend rendering & UX      | ~65%                                  | ~70%                                   |
| Config, identity & routing   | ~55% (Ariadne-only singleton)         | ~60%                                   |
| GAM memory write-back        | **~5%** (structurally excluded)       | ~70%                                   |
| Search indexing & recall     | **~5%** (permanently un-recallable)   | ~85%                                   |

## Part 3 — Gap register

27 deduped gaps. Severity reflects how badly the gap breaks "all three feel the same." Full per-cell evidence in run `wf_04d37ef9-9fa`.

### Critical

- **E2EE-11 (reframed)** — E2E participation is host-exclusive by construction. External bots have half-built wrap plumbing (BIK registration, SSK wrap recipients) that no code path consumes. Sealed-bot turns are a substantial new surface gated on real attestation (E2EE-21/22).
- **PARITY-4** — Enclave replies are **permanently un-recallable**: placeholder tsvector, no embedding (`embedding-outbox-handler.ts:101-106` skip), no GAM extraction (double-gated: `boundary-extraction-outbox-handler.ts:108`, `accumulator-outbox-handler.ts:142`), excluded from server search, no search tool in the enclave, and the client decrypt-cache search fallback is broken (matches placeholder). Encrypted agent work never enters the knowledge corpus — directly against the GAM differentiator. Largely physics-bound; any recall must be client/decrypt-side.

### High

- **E2EE-9 / E2EE-14** — sources dropped on enclave replies and trace steps; external protocol has no sources field at all.
- **#8** — three unreconciled gating models; `isToolAllowedByPolicy` still has zero production call-sites. Companion never reads the per-stream category policy; enclave never reads persona `enabledTools` — so a persona narrowed by its owner runs **un-narrowed** in E2E streams.
- **PARITY-2** — the enclave is a ~4-tool agent (`[load_attachment?, web_search?, read_url, general_research]`), missing 26 of ~30 companion tools including `describe_memo` (no GAM), `react_to_message`, and all search.
- **UX-12** — mid-turn interjection companion-only; reconsider machinery dead-but-compiled in the enclave; nonexistent for external.
- **E2EE-25 + PARITY-13** — no enclave `/fail` callback; external `/fail` finalizes `bot_invocations` but orphans the `agent_sessions` projection (spinning card until stale-heartbeat cleanup). External also has a two-clock liveness desync: `renew` extends the claim but never bumps the projection heartbeat → false orphan reclaim.
- **E2EE-8** — enclave park/backoff window has no session row, no card, no `onDLQ` hook: park exhaustion is fully silent.
- **UX-6** — enclave replies emit zero activity rows and zero push (E2E short-circuit at `activity/outbox-handler.ts:142`).
- **PARITY-1** _(new)_ — enclave token usage is computed (`enclave-ai.ts:40-41`), shipped (`run-turn.ts:245`), schema-validated (`session-handlers.ts:55`) — and **dropped** by `complete()` (reads only messageIds). E2E inference is invisible to `AICostService`/budget enforcement. Token counts carry no plaintext; small fix.
- **PARITY-3** — context divergence: companion gets named authors/temporal formatting/summary/quote-expansion; enclave gets 30 anonymous role+markdown messages; external gets `promptMarkdown` and nothing else.
- **PARITY-5** _(new)_ — enclave ignores workspace `agent_config_overrides` (reads the static built-in), so companion-Ariadne and enclave-Ariadne can be configured differently in the same workspace.
- **PARITY-6** — no per-stream agent binding for the enclave: hard-pinned `ARIADNE_AGENT_ID` singleton (companion binds `companion_persona_id`; external binds via `stream_active_actors`).
- **E2EE-7** — stale-generation parked turn can never be revived (revive is current-generation-only).

### Medium

- **E2EE-21** — enclave callbacks not bound to owning EIK; no AAD/generation re-validation on sealed ingest; the route family is workspace-blind (any `INTERNAL_API_KEY` holder can drive any session in any workspace — an INV-8 outlier).
- **PARITY-8** — no cancel channel to external bots (companion + enclave honor Stop-research).
- **PARITY-9** — external hard-capped at one final reply; no multi-message turns, no in-flight step lifecycle (single finalized `/steps` POSTs only).
- **E2EE-10/17/18/26b** — public read endpoints leak E2E placeholders/ciphertext with 200 OK (listMessages, find-by-metadata, attachments, search count).
- **PARITY-10** — edit-driven supersede/rerun is companion-only.
- **PARITY-11** — OTEL/Langfuse spans companion-only (enclave content suppression is the intentional INV-28 exemption; content-free token/latency spans are the bespoke gap, overlaps PARITY-1).
- **PARITY-12** — enclave decrypt-on-render UX cluster (skeleton flash, reflow, a11y silence, static sidebar preview, no auto-title).
- **PARITY-7** — two divergent ASCII-only mention extractors (`slug.ts:34` vs `invocation-outbox-handler.ts:25`); enclave has none (mentions sealed).
- **PARITY-14** — "Show trace and sources" message action gated off `actorType === 'bot'` even when a trace exists.
- **PARITY-15** — zero browser/e2e coverage of the external bot reply path.

### Undocumented mechanics worth knowing (from the matrix, not gaps per se)

- `protectToolOutputBlocks` (multimodal trust-boundary wrap) is exported but never called — multimodal tool output is injected **unwrapped** for both AgentRuntime hosts (`agent-runtime.ts:652-666`).
- Multimodal-IN is _inverted_: enclave inlines trigger media as native vision parts; companion only describes media in text + on-demand `load_attachment` (image-only, vision-gated). The enclave's `load_attachment` is broader (text/PDF/image) and ungated.
- External bots dispatch on **non-user** messages too (wrapped in a "decide whether to reply" prompt) — neither in-loop host does.
- GAM extraction triggers only on USER-authored messages; agent replies enter GAM only as surrounding context.

## Part 4 — Structural vs bespoke

**Fixed by construction under the recommended direction** (Turn Protocol spine + trust-tier negotiation — see the plan doc §4): #8 (one gating chokepoint), E2EE-9/E2EE-14 (required sources on the commit type + the single TraceMapper), UX-12 (required `InterjectionSource` port with `declaredUnsupported`), E2EE-25 (canonical terminal `failed` event), PARITY-9 (external promoted to the full TurnEvent vocabulary), PARITY-8's cancel surface, E2EE-11's _gate_ (trust-tier rule collapses scattered guards), PARITY-2's drift half (promptBlock+categories on the tool).

**Bespoke regardless of architecture:** PARITY-1 (wire `recordUsage`), PARITY-5 (override-applying persona resolution), E2EE-8 (parked visibility + onDLQ), UX-6 (content-free activity/push), PARITY-4 (client-side recall design), PARITY-6 (per-stream enclave persona binding), E2EE-7 (generation-aware revive), E2EE-21 (callback identity binding), E2EE-10 cluster (public read gating), PARITY-7 (one Unicode-aware extractor), PARITY-10/11/12/13/14/15.

## Part 5 — Build order

Spine first (each step is a shippable PR; revised from the plan doc's §6 per the verification):

1. **2a** — extract the shared `TraceMapper` from `SessionTraceObserver`; reimplement `EnclaveTraceObserver` as the same mapper + a sealing `StepSink`; add an `assertNever` exhaustiveness guard (closes the silent event-type divergence for both hosts). Behavior-preserving; safest first PR.
2. **1** — `sendMessage` sources **required**; sources ride inside `E2eSealedPayload` (`@threa/crypto`); enclave seals them; frontend decrypt surfaces them (closes E2EE-9).
3. **2b** — trace steps carry sources reusing 1's payload format (closes E2EE-14).
4. **3** — per-tool `promptBlock` + `categories` on `AgentToolConfig`; data-driven prompt builder + toolsets; activate `isToolAllowedByPolicy` on the companion _and_ plumb a companion-side policy source (without it the gate is a no-op).

Parallel quick wins (independent of the spine): PARITY-1 (S), PARITY-5 (S), PARITY-14 (S), external `/fail` projection finalization + renew-bumps-heartbeat (PARITY-13, S/M).

Then the protocol tier (plan §6 Steps 6–8: TurnRunner wrap, enclave sink rename, external manifest/negotiation), and the bespoke parity workstreams (UX-6, E2EE-8, E2EE-10 cluster, PARITY-3/6, E2EE-7/21) ordered by felt impact.

**Open product decisions** (cannot be settled by code): whether external bots ever get sealed turns (requires per-runner identity + real attestation first — E2EE-21/22); what "recall" should mean for encrypted streams (PARITY-4 — client-side index? explicit user opt-out framing?); whether the enclave should support non-Ariadne personas (PARITY-6).

## Provenance

Machine-readable outputs: verification run `wf_ab425350-0b1` (claim verdicts + Steps 1–3 assessment), parity run `wf_04d37ef9-9fa` (15 dimension matrices, 159 rows, deduped synthesis). Verification discipline: every non-confirmed claim verdict was independently re-derived by an adversarial re-checker; parity cells cite current-tree `file:line` evidence read by the mapping agents.
