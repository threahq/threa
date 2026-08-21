---
name: monitor-prod
description: >-
  Use after a merge to main or a deploy, or when asked to verify production, confirm a
  revision is live, watch a rollout, or investigate post-deploy behavior in Threa.
  Drives `bun run monitor` (scripts/monitor), the read-only CLI that proves which revision
  each plane serves, probes liveness, compares outbox/queue/agent/log signals against the
  pre-deploy window, and watches for regressions.
---

# Monitor prod

`bun run monitor` answers the post-launch questions in one read-only pass; the global
`monitor` skill sets the proof obligations, this CLI is how Threa meets them. Run it,
read the findings, then dig only where it points. Hand-rolled `gh run list … sleep 60`
loops, chunk-grepping `app.threa.io/assets`, and ad hoc Railway/DB queries are what this
replaces.

## Commands

| Need                                           | Command                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| Is the merge live on every plane, and healthy? | `bun run monitor status` (expects `origin/main`; `--sha <sha>` to pin)                  |
| Block until it is live, then check             | `bun run monitor verify --sha <sha>` (exit 2 on CI/deploy failure or 40m timeout)       |
| Keep watching after a risky launch             | `bun run monitor watch --for 2h --interval 10m` (prints only new/resolved findings)     |
| What errored since the deploy?                 | `bun run monitor logs --level error --since 2h --service backend [--grep <id>] [--raw]` |
| Which deployment is each Railway service on?   | `bun run monitor deploys`                                                               |

`--json` keeps stdout machine-readable (status/verify: the snapshot, verify progress on stderr;
watch: one JSON line per poll, first the snapshot then deltas; logs/deploys: the data); `--only`/`--skip` pick sections
(`revision,liveness,pipelines,logs,resources`); `--since 45m|2h|<iso>` moves the baseline
off the backend deploy time. Exit codes: 0 clean, 1 warn/pending, 2 fail, 3 usage or
missing credentials. `--help` has the flags.

## How to read a snapshot

- **revision**: one row per plane. `frontend` comes from `app.threa.io/version.json`
  (git short sha); Railway rows come from each service's newest deployment, and a
  `SKIPPED (No changes to watched files)` at the expected sha is a pass (that service's
  files did not change). A frontend `✗` names the failed GitHub run: CI failure means
  Deploy Cloudflare never started; a rerun is a deploy and needs Kris's go.
- **liveness**: `/health` per Railway host, router→control-plane, db-read-proxy, and the
  public API with the read-only key; a failure here is user impact, say so first.
- **pipelines**: outbox head and per-listener lag, dead letters, queue ready/running/DLQ
  per queue, agent/bot/scheduled failure counts, all as `since baseline (prior window)`.
  A listener flagged **stale** has not advanced for hours: a dead worker, or a row left
  behind by a removed listener (those are listed in `config.ts` as `DECOMMISSIONED_LISTENERS`,
  shown in the pipelines line and excluded from findings). **Ready with an old oldest-age** means workers
  are not claiming.
- **logs**: error/warn events per service versus the equal-length prior window, stack
  frames folded into their parent event, known boot noise counted apart, and **new log
  templates** (seen ≥3× since the baseline, never before it). Investigate templates
  with `monitor logs --grep`.
- **resources**: current CPU/memory versus the prior window's peak; rollover doubles
  peaks, so only sustained growth warns.

Thresholds and noise patterns live in `scripts/monitor/config.ts`; tune them there
with the reason, never by hand-waving in a report.

## Failure

A `fail` or a liveness regression is user impact: report what is observed, the
revision, and the blast radius immediately, then keep investigating with
`monitor logs` and the `prod-db-readonly` skill. Rollbacks, reruns, and restarts are
deploys: Kris decides.

## Report

Lead with the verdict line (`✓ OK` / `! WARN` / `✗ FAIL`), the revision table, and the
findings verbatim; add what you did about each finding. Separate what the snapshot
observed from what you inferred. Pipeline green without a revision row is not proof.

## Credentials

`RAILWAY_READONLY_TOKEN`, `DB_READ_PROXY_URL`, `DB_READ_PROXY_SECRET`,
`THREA_PROD_BASE_URL`, `THREA_PROD_READ_ONLY_API_KEY`, `THREA_PROD_DEFAULT_WORKSPACE`
from the environment, else `~/.threa.env.agents`. The CLI prints which names it loaded,
never values; a missing key skips its section and says so. Everything is read-only:
project-access token, SELECT-only proxy role, public read key.
