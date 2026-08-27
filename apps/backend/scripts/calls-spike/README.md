# calls-spike — M0 hostile matrix (PR 0.3, throwaway harness)

De-risk harness for voice/video calls. Proves the 0.1/0.2 control-plane
foundations survive hostility, and pins Cloudflare's API. **The answers live in
`apps/backend/src/features/calls/CLOUDFLARE_API.md`**, per question; this code is
throwaway-quality by design (harness + scripts only, nothing under `src/`).

## Two halves

- **Half A — control-plane matrix** (`matrix-*.ts`, `harness.ts`, `fake-cf-server.ts`).
  Boots N real backend instances against one Postgres DB on distinct ports, all
  pointed at a local fake-CF recorder so `cloudflareEnabled=true` without a CF
  account. Runs now. `run-all.ts` runs all five and prints an aggregate table.
- **Half B — live CF** (`live-cf/cf-*.ts`). Answers `CLOUDFLARE_API.md`'s 7
  questions against the real CF API. Gated on `CLOUDFLARE_REALTIME_APP_ID/SECRET`
  (shared `cf-env.ts`); fails fast with a clear message when absent.

Both halves have run: Half A 5/5 green, Half B against a real CF dev app on
2026-07-19 (CF-2 confirmed two-way media through our own proxy). What Half B
settled, and what it left open, is recorded per question in `CLOUDFLARE_API.md`.

## Matrices

| Script                      | What it breaks                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `matrix-1-two-instances.ts` | cross-instance join/leave/state fan-out + removal eviction                                             |
| `matrix-2-kill9.ts`         | `kill -9` the instance holding a call; surviving sweeper reaps → zero stranded rows + CF session close |
| `matrix-3-two-devices.ts`   | one user two devices: second-device rejection + takeover epoch fence                                   |
| `matrix-4-glare.ts`         | N concurrent `startCall` on one stream: exactly one call (real Postgres)                               |
| `matrix-5-grace-revive.ts`  | empty-grace, join-revive, sweeper never ends a revived call                                            |

## Knobs (env)

- `CALLS_SPIKE_DB_URL` — Postgres URL for the shared DB. Default
  `postgresql://threa:threa@localhost:5454/threa_test`. **Never point at a DB a live
  `dev:test` stack is using** — the sweeper reaps any lapsed endpoint globally.
- `CALLS_SPIKE_VERBOSE=1` — stream each spawned backend's stdout/stderr.
- `CALLS_SPIKE_GLARE_N` — concurrent starters for matrix-4 (default 12).
- `CLOUDFLARE_REALTIME_APP_ID` / `_APP_SECRET` / `_API_BASE` — Half B only.

Backend instances are spawned on OS-assigned free ports (no collision with a
co-resident dev stack); pools are shrunk (main 6 / listen 3 / realtime 3) so
several instances stay under Postgres's connection cap. Each run seeds a fresh
workspace and cleans up only its own rows — `threa_test` is never truncated.

## Run

```sh
bun run db:start                                          # if Postgres isn't up
bun apps/backend/scripts/calls-spike/run-all.ts           # all 5 + table
bun apps/backend/scripts/calls-spike/matrix-2-kill9.ts    # one standalone
# Half B (needs a CF dev app; else fails fast, exit 2):
CLOUDFLARE_REALTIME_APP_ID=… CLOUDFLARE_REALTIME_APP_SECRET=… \
  bun apps/backend/scripts/calls-spike/live-cf/cf-1-session-lifecycle.ts
```
