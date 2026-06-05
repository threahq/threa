# E2EE Maintainability Audit — June 2026

- **Date:** 2026-06-06
- **Code state:** branch `improve-e2ee` @ `88ba2745` (on `origin/main` @ `aec31076`, after #793–#798).
- **Method:** multi-agent workflow (run `wf_45e0b0d1-221`, 14 agents): 8 area inventories (every claim counted via grep/wc, `file:line`-cited) → adversarial keep-vs-rewrite debate → 3-lens judge panel (architecture soundness, cost/risk, product velocity) → synthesis.
- **Scope:** code maintainability only — explicitly **not** security (Part I audit) or UX polish (Part II audit). The question: is this implementation worth saving, and is "we handle everything at the leaf instead of the root" the right diagnosis?

## The verdict in one paragraph

**Hybrid staged rewrite — unanimous across all three judges.** The leaf-vs-root diagnosis is **half-right, and the split is the whole point**: the cryptographic/data core is already root-handled and genuinely well-built (keep verbatim, freeze under a CI guard), while three _seam layers_ own essentially all the recurring bugs and have the wrong _shape_ — you cannot patch a shape, you replace it. Notably, the strongest keep case and the strongest rewrite case converged to ~90% the same plan (~9–12 PR-sized units either way); the difference was framing. Pure keep understates that the session store's state shape must be replaced; pure rewrite would discard 331+ passing tests and re-litigate solved problems (AAD binding, race-safe generation bumps) for zero benefit.

## Where the hypothesis holds (counted, not vibed)

| Seam                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend read-side opt-out is leaf-scatter | **30** `isE2eStream`/`filterE2eStreamIds` call sites across ~11–16 content-reading handlers, each hand-writing its own skip in **4 distinct shapes** (return / return [] / push+continue / throw). The Part I audit's own root-cause for E2EE-1/2/3/5: "any future caller that forgets is the next one."                                                                                                                                                                                                 |
| Frontend gate-scatter                     | **65** `e2eEnabled` references across 20 files, **2 coercion idioms** (`=== true` vs `?? false`) where a missing flag silently degrades to _plaintext behavior_. No `StreamCapabilities` descriptor exists.                                                                                                                                                                                                                                                                                              |
| Frontend read path                        | **6 parallel decrypt pipelines**, each re-deriving the same 5-state machine (locked/pending/decrypted/failed/plaintext); one hook's comment admits it "mirrors" another.                                                                                                                                                                                                                                                                                                                                 |
| Sealed wire shape                         | Defined **3+ times** (`@threa/types`, enclave `sessions.ts`, backend `session-handlers.ts`); the two Zod copies have **already drifted** (base64 vs `string.min(1)`); fields have been silently dropped twice (Zod strips unknown keys).                                                                                                                                                                                                                                                                 |
| Session store                             | `e2e-session-store.ts` is a **1009-LOC god object**: 9 concerns, 15 exported functions, unlock tier encoded as **two free-floating nullable booleans** whose staleness the code's own comment admits (patched by the `NO_UNLOCK_PROMPT` band-aid spread to **14 sites**), concurrency hand-threaded as **33 generation-guard references** across 8 async mutators, 5 inlined IDB helpers (INV-5 violation), 3 of 15 functions with zero test coverage (incl. `unlockWithBiometric`, `revokeKeyForUser`). |

**Churn confirms the seams own the bugs:** the ~22–26 e2e fix commits cluster on seam keywords (unlock 5, pin 5, companion 5, thread 4, seal 4, draft 4) and seam files (`stream-panel.tsx`, `e2e-session-store.ts`, `use-decrypted-message-content.ts`) — **not** on crypto (rotation/plaintext-leak each produced exactly 1 fix commit).

## Where the hypothesis is wrong (already root-handled — keep verbatim)

- `packages/crypto`: clean primitives + AAD discipline, 33 round-trip/tamper tests. (Gap: exports types-not-validators, forcing the 6 shape re-declarations; `parseSealedPayload` not version-tolerant.)
- `apps/frontend/src/lib/crypto/*` leaf modules: small, single-purpose, all delegating to `keys.ts` instead of reinventing AES-GCM; 1231 LOC of tests. **Not the problem.**
- The write sink (`assertE2eContentMatch`, INV-E1) and the single seal path (`seal-send.ts`), the race-safe `e2e-streams` backend module, the thread-inheritance fail-closed guard (#793/#798).
- `packages/agent-runtime` + the new `TraceMapper` — reused verbatim by companion + enclave.

So the honest restatement: **the leaf problem is real but bounded to 3 seam layers; the hard core was done right.** This is also why "throw it all out" loses: a rewrite forfeits the part that's good.

## Grade table

| Area                                 | Grade  | Verdict                                                                                                                                                                                                                      |
| ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend `lib/crypto/*` leaf modules | **A**  | Keep verbatim; freeze under a guard                                                                                                                                                                                          |
| `packages/crypto`                    | **B−** | Keep verbatim; _add_ exported Zod validators + version-tolerant parse + 3 missing tests                                                                                                                                      |
| Enclave app + `enclave-runtimes`     | **B−** | Agent loop exemplary (keep); session lifecycle is an implicit ~20-site machine (rework after a test stub exists)                                                                                                             |
| Backend E2E read-side policy         | **C+** | Write sink A-grade; the 30 read-side guards → one dispatch wrapper                                                                                                                                                           |
| Sealed wire contract                 | **C+** | Reimplement as ONE Zod schema, `z.infer` the type                                                                                                                                                                            |
| Key/device/setup lifecycle           | **C+** | Statechart core strong; device protection is an implicit 3-IDB-column ladder; post-setup PIN/biometric enablement **does not exist** (the actual "can't enable PIN on desktop" bug — it's only offered during initial setup) |
| `e2e-session-store.ts`               | **C**  | Mutator logic correct and portable; the **container** (state shape, concurrency model, inlined IDB) must be reimplemented behind its stable API                                                                              |
| Frontend read/decrypt path           | **C**  | Keep envelope/key-cache/decrypt-cache; reimplement the read layer (one resolver, one reader, one placeholder)                                                                                                                |

## Why the specific bugs you hit keep happening (mechanically)

- **"Stale state after a change" class** (#790, #791 …): every transition must remember to reset _other_ flags and re-check a hand-threaded generation counter after every `await` — 33 manual sites; miss one and a stale response clobbers fresh state. Unreviewable by inspection.
- **Wrong unlock modal / biometric weirdness**: the modal routes off `webauthnProtected → pinProtected → passphrase` booleans that the store itself documents can go stale. The state is logically _one-of_ {passphrase, pin, biometric} but stored as two independent booleans.
- **"Can't enable PIN on desktop"**: not a bug in PIN code — **the enablement path doesn't exist**. PIN/biometric are offered only inside the initial setup modal; there is no post-setup `enableDeviceUnlock` action or Settings surface.
- **"Finish setup" popup jank**: the repair affordance is a leaf-derived view over wrap-health state with no central statechart deciding when repair is actually needed.
- **Feature N+1 forgets E2E**: there is no single place a new feature author learns the rules — each of ~16 content-reading handlers independently remembers (or forgets) to skip E2E streams.

## The path (judges' unanimous plan)

**Phase 0 (1 small PR, FIRST):** carry-forward regression suite encoding every learned constraint _against the current code_ — #790 single-value transitions, #791 ciphertext-at-rest + draft write-after-purge, locked-tier-is-exactly-one-of, loadGeneration discipline, thread-inherits-root-SSK fail-closed, lock-clears-all-plaintext-incl-IDB-drafts, rotation-must-not-downgrade-tier. Plus a CI/CODEOWNERS guard freezing `packages/crypto` + `lib/crypto/*` so seam PRs cannot touch the good substrate.

**Chokepoint 1 (1 PR): backend content-access gateway.** One `withPlaintextStreamOnly(handler)` wrapper in the outbox layer owning resolve + ack/skip semantics (batch-cursor vs single-event, explicitly); migrate the 30 call sites. Outbox-redelivery integration test per handler kind _before_ migrating.

**Chokepoint 2 (1 PR): single sealed-shape validator.** Each sealed shape once as a Zod schema in `@threa/crypto`, `z.infer` types, version-tolerant `parseSealedPayload`. **Must land before the agent-runtime spine's Step 1 adds `sources`**, so that track has one schema to extend.

**Chokepoint 3a (1 PR): `useStreamCapabilities` resolver** — `{sealed, canEdit, canUpload, previewPlaintext, serverSearch, …}`; route the 65 `e2eEnabled` refs and the draft guards through it; kill the coerce-to-false-means-plaintext failure mode.

**Chokepoint 3b (1 PR): one decrypt boundary.** Collapse the 6 pipelines into one `useDecryptedContent<T>` returning a tagged union where `locked` is retryable and only `corrupt` is terminal; one `readSealedPayload`; one `StatusPlaceholder`. (Optional follow-up: decrypt-at-ingest, gated on IDB-stays-ciphertext.)

**Phase 5+ (2 PRs, LAST, behind the stable 15-function API): session-store container reimplement.** One discriminated union for status+tier+trust (deletes `NO_UNLOCK_PROMPT` and its 14 spreads — makes the bug class _unrepresentable_), one per-scope mutation queue (collapses 33 guards to one enforcement point, fixes the `setDeviceTrust` race for free), IDB helpers → an `e2e-device-key` repository (INV-5), tier logic → one strategy table `{persist, resume, survivesRotation}`, plus `enableDeviceUnlock` + the Settings subsection (the real PIN/biometric product gap). Missing tests (`unlockWithBiometric`, `revokeKeyForUser`) added FIRST; the existing 24-case suite is the regression contract.

**Enclave session lifecycle: blocked on test infra.** A dev/test-hosted enclave stub is a **hard prerequisite** before any lifecycle rework — without it the whole stuck-state cluster (E2EE-6/7/8/12/13/25) is structurally untestable, which is the direct mechanical answer to "I vibe too much without being able to test." The product-velocity judge adds: feature-flag/mothball the enclave-agent surface until the stub exists; ship the client-side chokepoints first.

Total: **~9–12 PR-sized units** to "boring and reliable" — roughly the same either way the debate was framed, which is itself the strongest evidence this is a refactor-shaped problem, not a rewrite-shaped one.

## Do the existing plans cover this?

**No — different axis, and conflating them is the trap.** The agent-runtime-pluggability spine addresses agent-_host drift_ (sources, trace parity, gating, fail/park lifecycle, external on-ramp). It says nothing about: the session-store shape, post-setup PIN/biometric enablement, the backend read-side gateway, the capabilities resolver, the sealed-schema collapse, or the decrypt boundary. Those are this audit's separate track. One ordering constraint links them: **Chokepoint 2 before spine Step 1** (one schema to add `sources` to). One shared prerequisite neither plan delivers: the dev/test enclave stub.

## Do-not-relearn register (constraints a rebuild must honor)

INV-E1 ciphertext-at-rest (IDB and Postgres, always) · single-value state transitions (#790) · encrypted drafts never on disk + purge-beats-write (#791) · locked tier is exactly one of {passphrase, pin, biometric} · stale async responses never clobber fresh state (and `setDeviceTrust` must join the guard) · thread replies seal under the ROOT SSK, fail closed (#793/#798) · `lock()` clears decrypt cache + key cache + attachment refs + IDB drafts · rotation must not silently downgrade a PIN/biometric device to plain auto-resume · batch-cursor handlers must `seen.push+continue` (or the event loops forever) while single-event handlers must not · `z.infer` from one schema (Zod strips unknown keys — fields were silently dropped twice) · decrypt failure is tagged, `locked` retryable, only `corrupt` terminal · `isUserVerifyingPlatformAuthenticatorAvailable` gating + non-extractable PKCS#8 import stay exactly as-is · the enclave's dependency-free OpenRouter transport is the one intentional non-`createAI` path (INV-28 exemption) — do not "normalize" it.

## Provenance

Run `wf_45e0b0d1-221`: 8 inventories (frontend crypto core, frontend leaf-scatter catalog, backend guards, enclave app, crypto package, key lifecycle, churn/test-gap archaeology, transparency-target feasibility) → keep/rewrite adversarial cases → 3 judges → synthesis. All counts repo-verified by the agents (grep/wc), spot-checked across contradicting cases by the judges.
