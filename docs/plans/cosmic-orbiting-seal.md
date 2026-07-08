# Harden the residual flaky boundary-extraction eval cases

## Context

The `/eval` on-demand runner now works end-to-end in CI (PR #1227; the
`OPENROUTER_API_KEY` Actions secret is set — a real run on PR #1237 posted a
report: `gpt-5.4-mini`, 228 executions, $0.69, 7m42s). That was the first at-scale
measurement of the boundary-extraction suite against the production model. Its
6-run sample flagged six cases below the strict per-case `--min-pass-rate 0.8`
gate, but 6 runs at `temperature 0.2` is too noisy to trust per-case.

A reliable **10-run in-sandbox baseline** (full suite, tuned HEAD) reframed the
problem. Aggregate gates were already healthy — accuracy **0.966**,
decision-accuracy **0.984**, average-confidence **0.965** — and only **one** case
was meaningfully broken:

| Case                                    | 10-run baseline | Note                                   |
| --------------------------------------- | --------------- | -------------------------------------- |
| `resolution-explicit-001`               | **5/10**        | the real outlier                       |
| `live-pivot-mid-blob-001`               | 7/10            | hardest live-pivot (72-msg stale blob) |
| `live-pivot-btw-001`                    | 8/10            | at the line                            |
| `reply-quote-continues-quoted-conv-001` | 9/10            | noise                                  |
| `live-pivot-mid-blob-sum-001`           | 9/10            | noise                                  |
| `entity-magnet-distinct-aspect-001`     | 9/10            | noise                                  |
| all others (32)                         | 10/10           | —                                      |

The CI 6-run flakes (`live-pivot-new-subject-001` at 4/6, `entity-magnet-distinct`
at 4/6) were sampling noise — both are 9–10/10 over 10 runs.

## Root cause of the one real failure

`resolution-explicit-001` is **not** a boundary-decision failure. On the message
"Perfect, that fixed it! The deployment is now working. Thanks everyone!", the
model correctly sets `status: "resolved"` but scores completeness **5** when the
case expects `minScore: 6` (evaluator: `"Score 5 below expected min 6"`).

The gap: the 1–7 completeness scale is defined **only** in a zod `.describe()`
(`config.ts:146`), never in the prompt body — `## Output Requirements` (line 91)
just says `score (1-7)`. With no anchor, the model hedges on borderline
resolutions. Diagnostic contrast: `resolution-settled-plan-sv-001` (also
`minScore: 6`) passes 10/10, while `resolution-explicit-001` reaches ≥6 only half
the time — same assertion, no rubric.

## What was done

**One targeted, additive change** — a completeness rubric in the prompt body
(`BOUNDARY_EXTRACTION_PROMPT`, `## Output Requirements`,
`apps/backend/src/features/conversations/boundary-extraction/config.ts`):

> - score (1-7) measures how settled the conversation is: 1-2 = just opened, no
>   substance yet; 3-5 = active exchange, the question or task still open; 6-7 =
>   reached an explicit conclusion — the problem confirmed solved, the question
>   answered, or a plan agreed. An explicit resolution ("that fixed it", "works
>   now, thanks", "låter som en plan") scores 6 or 7, not 5; pair it with status
>   "resolved".

Shared by prod and evals per INV-44. No code-path, schema, model, or temperature
change.

### Deliberately NOT changed

The live-pivot and entity-magnet sections were left untouched. Over 10 runs they
sit at 7–10/10, and the prompt **already** addresses them explicitly — line 63 is
the subject-change test and line 64's show-and-tell rule literally quotes
`"detta känns fint"`, the exact opening of the `live-pivot-new-subject` message.
These are at the model's reliability ceiling on genuinely ambiguous inputs (a
short excited one-liner into a 30-min-stale 72-message blob). Adding more prose
there is low-value and risks regressing the 32 green cases that depend on the same
shared logic (`continuity-short-ack`, `live-reaction-continues` — both 10/10).

## Result (validation)

Full-suite `-r 10`, in-sandbox, before → after the rubric:

- `resolution-explicit-001`: **5/10 → 10/10** ✅
- `resolution-settled-plan-sv-001`: 10/10 → 10/10 (other completeness case — no regression)
- Aggregate accuracy: 0.966 → **0.979**; decision-accuracy 0.984 → 0.984
- Live-pivot family nudged up (`btw` 8→9, `mid-blob` 7→8)
- Every case now clears `--min-pass-rate 0.8` (lowest is `live-pivot-mid-blob-001`
  at 8/10); no previously-passing case dropped.

## Verification harness (in-sandbox)

Bun 1.3.11's `fetch` can't complete TLS through the agent proxy's CONNECT tunnel,
but `curl` can. To run evals in this sandbox:

- Local Postgres 16 + pgvector on `:5454`, role `threa/threa`, cluster under
  `/var/lib/postgresql/evaldata` (docker is unprivileged here).
- Preload a curl-backed `fetch` shim so `generateObject` reaches OpenRouter:
  `bun --preload <shim> evals/run.ts -s boundary-extraction -r 10 --min-pass-rate 0.8 --no-langfuse`.
- `OPENROUTER_API_KEY` is present in the sandbox env.

CI confirmation: comment `/eval -s boundary-extraction -r 10 --min-pass-rate 0.8`
on the PR to re-measure against the canonical runner (CI has direct egress; no shim
needed there).

## Out of scope

- No temperature/model change (`mini`/`0.2` are deliberate, `config.ts:6-13`).
- No new eval cases (INV-36).
- The curl-fetch shim is a sandbox-only workaround, not checked in.
- Existing production "Fable"/blob merges are historical; tuning only affects
  future classification — a backfill is a separate task.
