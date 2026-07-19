# Calls M0 spike — hostile-matrix findings (PR 0.3)

De-risk milestone for voice/video calls (`docs/plans/voice-video-calls.md` §Rollout
M0). Goal: prove the 0.1/0.2 foundations (split-table schema, `CallService`
state machines, endpoint/lease/incarnation model, CF proxy, `/calls` gateway,
sweeper) survive hostility, and pin Cloudflare's real API before any M1 client work.

Two halves:

- **Half A — control-plane hostile matrix** (`apps/backend/scripts/calls-spike/`).
  Runs now against real backend instances + a local **fake-CF recorder** (no CF
  account needed — the endpoint/lease/sweep machinery under test moves no media).
  **Status: EXECUTED, 5/5 GREEN.**
- **Half B — live-CF validation** (`scripts/calls-spike/live-cf/`). Answers the 7
  `CLOUDFLARE_API.md` questions against the _real_ CF API. **Status: BUILT,
  UNEXECUTED — blocked on a CF dev app.** Every script fails fast with a clear
  needs-creds message (verified).

## Exit-criteria table

| Criterion (from the plan / PR brief)                                                 | Result               | Number                                                                                                        |
| ------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| Two backend instances: join/leave/state fan-out cross-instance                       | **PASS**             | cross-instance roster delivery **~11 ms** (Postgres socket.io adapter)                                        |
| Two backend instances: removal evicts cross-instance                                 | **PASS**             | removed participant + endpoints closed in shared DB; surviving instance's roster drops them                   |
| `kill -9` mid-call ⇒ endpoints reaped, participants left, call → empty_grace → ended | **PASS**             | reap→grace **~14.7 s**, grace→ended **~15.1 s** after each deadline elapsed (isolates the 15 s sweep cadence) |
| `kill -9`: **ZERO stranded rows** (the exit criterion)                               | **PASS**             | 0 live endpoints, 0 joined participants, call `ended` (reason `reaped`)                                       |
| `kill -9`: sweeper attempted CF session close (no orphaned session)                  | **PASS**             | fake CF recorded exactly 1 `tracks/close force:true` for the stranded session                                 |
| Two devices, one user: 2nd admit without takeover rejected                           | **PASS**             | `CALL_ENDPOINT_ACTIVE` (409)                                                                                  |
| Two devices: takeover fences the old epoch                                           | **PASS**             | new epoch `2 > 1`, old endpoint `closed`, old renew → `CALL_LEASE_SUPERSEDED`                                 |
| Glare: exactly one call under N-concurrent start                                     | **PASS**             | 12/12 concurrent starts → **1** active call row, 1 `created=true`, 12 joined, 0 rejected                      |
| Grace/revive: join during grace revives; sweeper never ends a revived call           | **PASS**             | revive → active; grace sweep ended 0; expired grace ended 1 (reason `completed`)                              |
| Time-to-join (control plane: socket `call:join` ack)                                 | **PASS**             | sub-second on a warm instance                                                                                 |
| Live media time-to-join / connect success / getStats bytes                           | **BLOCKED-ON-CREDS** | Half B `cf-2` (needs CF dev app)                                                                              |

## Per-matrix result

Run everything with `bun apps/backend/scripts/calls-spike/run-all.ts` (writes
`last-results.json`). Each matrix is also runnable standalone and emits a
`__MATRIX_RESULT__` JSON line.

### matrix-1 — two instances (cross-instance fan-out) — **PASS**

userA's `/calls` socket on instance A, userB's on instance B (distinct processes,
one shared `threa_test`). B's join, A's mute, and B's leave each fan out to the
socket on the _other_ instance via the socket.io Postgres adapter (**~11 ms**).
Removal marks the target `removed`, closes their endpoints (shared DB, so
instance-agnostic), and the surviving instance's next roster broadcast drops them.

### matrix-2 — `kill -9` mid-call — **PASS** (the crash exit criterion)

userA's socket + CF session on instance A; instance B runs only as the surviving
sweeper. SIGKILL A. Because the lease is **persisted, not in-memory**, A's death
stops the renewals; once the lease lapses, **instance B's real 15 s sweeper** reaps
the stranded endpoint → participant `left` → call `empty_grace` → `ended`
(`reaped`), and best-effort closes the CF session (recorded by the fake). **Zero
stranded rows.** The lease/grace deadlines are fast-forwarded into the past to
simulate the 45 s TTL elapsing (the documented reap mechanism) so the run is
deterministic; the reap + CF close are done by B's real sweeper, not the harness.

### matrix-3 — two devices, one user — **PASS**

Device 1 on instance A holds the endpoint. Device 2 (instance B) without takeover
is rejected `CALL_ENDPOINT_ACTIVE`; with takeover it closes device 1's endpoint and
mints a higher epoch. Device 1's subsequent lease renew fails the epoch fence
(`CALL_LEASE_SUPERSEDED`) — the old binding is invalidated. Device 2's renew works.

### matrix-4 — product glare under real concurrency — **PASS**

12 users fire `startCall` on the same stream simultaneously against real Postgres.
Exactly **one** `calls` row exists, exactly one starter observed `created=true`, all
12 land in that one call as joined participants, 0 rejected — the
one-active-call-per-stream partial unique index holds. (Note: Postgres blocks the
losers' `INSERT … ON CONFLICT` on the unique index until the winner commits, so
every loser's same-tx re-read sees the winner — no spurious `CALL_START_CONFLICT`.)

### matrix-5 — empty-grace + revive + sweep — **PASS**

Last leave → `empty_grace(completed)`. A join during grace revives to `active`
(reason cleared). The grace sweeper does **not** end the revived call (its
`FOR UPDATE` + `NOT EXISTS` re-check guards the join-vs-reap write-skew). When grace
genuinely expires, the sweeper ends the call with the reason recorded at grace entry.

## Bugs found & fixed in this branch

**None.** The hostile matrix exposed **no correctness bug** in the 0.1/0.2
control-plane code — every race guard (glare unique index, lease-epoch fence,
takeover, grace revive-vs-reap, cross-instance reap + CF close) held under the
matrix. No production-code change was required by the matrix (harness code lives
entirely under `apps/backend/scripts/`, outside `src/`).

## Observations feeding M1 (not bugs — tuning / gaps)

1. **Crash-cleanup latency is bounded by lease TTL + sweep cadence, twice.**
   `ENDPOINT_LEASE_TTL_MS` = 45 s and the sweeper interval = 15 s, so a crashed
   call's endpoints reap up to **~60 s** after the crash, and the emptied call row
   ends up to **~60 s after that** (`EMPTY_GRACE_MS` 45 s + 15 s) — worst case
   ~**120 s** wall-clock for a crashed 1:1 call to fully close. Acceptable for M0,
   but M1's rejoin bar / `call_ended` timeline card should either tolerate that
   window or M1 should consider a shorter calls-specific lease TTL / sweep cadence.
   (The 15 s per-stage latency was measured directly; the TTL/grace portions are the
   config constants, fast-forwarded in the harness rather than waited out.)
2. **Removal has no transport trigger yet.** `removeParticipant` is a correct
   `CallService` transition, but no socket/REST surface invokes it (host-control is
   deferred to M1 with guest design). Cross-instance eviction therefore relies on a
   _subsequent_ roster-changing event to rebroadcast the drop. M1 should wire a
   `call:remove` (or host-control REST) that fans the roster immediately.
3. **Sweep cadence is a hardcoded 15 s** in `server.ts` (`createCallSweeper(callService)`
   with no interval option). Fine for prod; the matrix works around it by
   fast-forwarding deadlines. If M1 wants faster crash recovery, expose the interval.

## Half B — live-CF status (BUILT, UNEXECUTED)

`scripts/calls-spike/live-cf/` contains four probes, each gated on
`CLOUDFLARE_REALTIME_APP_ID` / `_APP_SECRET` (shared `cf-env.ts`). With no creds
present, all four **fail fast with exit code 2** and the message pointing at
`CLOUDFLARE_API.md` (verified). See that doc's "0.3 spike status" table for which
question each answers:

- `cf-1-session-lifecycle.ts` — Q1 (teardown verb + inactivity timeout), Q7 (error codes).
- `cf-2-publish-pull.ts` — Q2/Q3 (publish/pull contract, mid vs trackName), Q4 confirm.
  Two real headless-Chromium peers (`--use-fake-device-for-media-stream`) publish/pull
  through OUR proxy against the real SFU; asserts getStats bytes > 0 both directions.
- `cf-3-reachability.ts` — Q6 (STUN/TURN/TLS-443 reachability) + a manual matrix for
  strict-NAT / enterprise egress / network handoff / Safari-iOS.
- `cf-4-simulcast-probe.ts` — Q4/Q5 (simulcast/layer request shape, optional flags).

The one thing Half A _could_ confirm about the CF plane without creds — that the
**sweeper actually calls `closeSession()` on a reaped endpoint's CF session** — is
GREEN (matrix-2, via the fake recorder).

## How to run

```sh
# Prereqs: local Postgres up (bun run db:start). Uses threa_test by default;
# override with CALLS_SPIKE_DB_URL. Do NOT point it at a DB a live dev:test stack
# is using — the sweeper reaps any lapsed endpoint globally.
bun apps/backend/scripts/calls-spike/run-all.ts          # all 5, aggregate table
bun apps/backend/scripts/calls-spike/matrix-2-kill9.ts   # one matrix standalone
CALLS_SPIKE_VERBOSE=1 bun …/matrix-1-two-instances.ts    # stream backend logs

# Half B (needs a CF dev app; otherwise fails fast):
CLOUDFLARE_REALTIME_APP_ID=… CLOUDFLARE_REALTIME_APP_SECRET=… \
  bun apps/backend/scripts/calls-spike/live-cf/cf-1-session-lifecycle.ts
```

Run matrix / live-cf scripts from the **repo root** (the harness spawns backend
instances via `bun apps/backend/src/index.ts`, resolved against cwd).

## Reproducibility caveats

- **Typecheck.** The scripts are covered by a committed scoped project,
  `apps/backend/scripts/calls-spike/tsconfig.json` (extends the backend tsconfig,
  includes `src` + `evals` + the scripts). Reproduce with
  `cd apps/backend && bunx tsc --noEmit -p scripts/calls-spike/tsconfig.json` (0
  errors). Note the repo's default `bun run typecheck` does **not** cover `scripts/`
  (backend `tsconfig` includes only `src` + `evals`, per repo convention), so this
  scoped invocation is how the harness is typechecked, not CI.
- **`test:unit`.** Green only from a clean env. A pre-existing gitignored
  `apps/backend/.env` (Linear OAuth vars) is Bun-auto-loaded and makes the 19
  `src/lib/env.test.ts` `loadConfig` tests throw (`WORKSPACE_INTEGRATIONS_SECRET`
  required). This is the documented stray-`.env` gotcha, **not** a spike regression —
  the harness spawns instances with explicit env to avoid it. Run `test:unit` with
  that stray `.env` absent (stash it) to reproduce green.
- **cf-2 Q3 wiring.** The puller now injects the publisher's real `cf_session_id`
  (resolved from the publisher endpoint row after it publishes) into the CF pull
  body — no placeholder. cf-2 is runnable end-to-end once CF creds arrive.
- **cf-3 creds-free probes.** The four TCP reachability probes print before the
  creds check, so partial reachability is visible without a CF dev app (the
  authenticated signaling round-trip still fails fast without creds).
