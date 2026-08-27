# AI Evaluation Framework

Evaluate AI components with production-identical configuration. Ensures evals test the same code paths and config as production.

## Quick Start

```bash
# Run all suites with production config
bun run eval

# Run specific suite
bun run eval -- -s companion

# Run specific test case
bun run eval -- -s companion -c scratchpad-companion-greeting-001

# Repeat every case 6 times and read per-case pass rates (see "Variance")
bun run eval -- -s boundary-extraction -r 6 --min-pass-rate 0.8

# Compare models
bun run eval -- -s companion -m openrouter:anthropic/claude-haiku-4.5,openrouter:openai/gpt-5.4-nano

# Machine-readable results (per-case pass rates, usage, executed models)
bun run eval -- -s memo-classifier -r 3 --json results.json

# Run from config file
bun run eval -- --config evals/example-config.yaml

# Run one suite's runs out of a multi-suite config
bun run eval -- --config evals/companion-model-comparison.yaml -s persona-style
```

## Available Suites

| Suite                 | Description                         |
| --------------------- | ----------------------------------- |
| `companion`           | Full companion agent with tools     |
| `stream-naming`       | Stream name generation              |
| `boundary-extraction` | Conversation boundary detection     |
| `multimodal-vision`   | Vision/attachment understanding     |
| `memo-classifier`     | Knowledge-worthiness classification |
| `memorizer`           | Memo generation from messages       |
| `voice-polish`        | Dictation correction and structure  |

### voice-polish gating semantics

The dictation suite grades the user-visible guarantee, not internal retry
mechanics. Interim (live-deadline) passes are discardable by architecture — a
slow pass times out non-destructively while raw STT stays visible — and hosted
provider latency has a random tail, so:

- **Timeouts (live or final) are valid typed outcomes case-level.** Case
  evaluators assert outcome type (never raw-text-as-success, never
  empty/truncated/provider-error) and grade the content, structure, language,
  and stability of every _successful_ pass. A case whose final pass timed out
  has nothing to grade and is neutral.
- **Latency is gated run-level**, where sample sizes make it meaningful:
  final-cohort p95 of completed calls + 750ms must fit the 8s cap, and the
  final-cohort timeout rate must stay at or below 15% (loose catastrophe bound;
  worst observed provider-jitter rate is ~4%). Live metrics are reported, not
  gated.
- A `voicePolishDecision` block in the JSON report records qualification, the
  mechanical model/prompt selection, and whether the run may pass; the exit
  code enforces it, so a comparison cannot complete silently without a
  selection decision.

## Run from a PR comment (`/eval`)

Comment `/eval` on any PR to run a suite against that PR's code and get the
results posted back as a comment (an at-a-glance table + per-case `<details>`,
in the code-review report style). Requires write access. The `Slash Commands`
workflow spins up postgres+pgvector, runs the eval, and posts the report.

```
/eval                                             # boundary-extraction, production config
/eval -s memo-classifier -r 6 --min-pass-rate 0.8 # 6 runs, per-case pass rates
/eval -m openrouter:openai/gpt-5.4-mini,openrouter:openai/gpt-5.4-nano  # compare models
```

Accepted flags mirror the CLI: `-s/--suite`, `-c/--case`, `-m/--model` (≤4),
`-r/--runs` (≤12), `-p/--parallel` (≤8), `-t/--temperature`, `--min-pass-rate`.
Values are allowlist-validated (`evals/slash/parse-args.ts`) and cost/latency
are capped. Needs the `OPENROUTER_API_KEY` repo secret.

## Rescore: scoring changes must not pay for generation again

A `--json` report stores each case's raw generations, so changing an evaluator
or swapping the judge — both _scoring_ changes — replays over stored text
instead of re-running live agent turns:

```bash
bun run eval -- --config evals/companion-model-comparison.yaml -r 3 --json run.json
bun run eval -- --rescore run.json --json rescored.json                  # same judge, new evaluators
bun run eval -- --rescore run.json --judge openrouter:google/gemini-3.5-flash-lite --json cross.json
```

This exists because the August 2026 Ariadne comparison re-ran 200+ live turns
twice to re-grade text it already had, and then hit the OpenRouter key's weekly
limit mid-run — which silently invalidated a whole arm, since a rejected call
looks exactly like a model that chose not to answer.

Rescore reports only what _rescoring_ cost (judge calls); the generation cost
stays attributed to the original run. It refuses a report with no stored
outputs, and an evaluator that reaches for the database fails loudly rather
than scoring against nothing.

**It cannot replace a live run** when the prompt, model, temperature, case set
or task code changed. Those are new generations.

## Variance: tune against tallies, not single runs

The components under test are stochastic even at low temperature — borderline
cases flip run-to-run, and a single green run is not evidence (a fully green
single-run suite once masked every live failure mode these suites now encode).
Use `--runs N` when tuning prompts or comparing models: each case reports a
pass rate ("4/6"), run-level evaluators aggregate across all runs, and
`--min-pass-rate` sets the threshold a case must clear for the exit code.

## Model overrides are verified at runtime

`-m` genuinely overrides the model for components that read their config via
`ConfigResolver` (INV-44) — the runner wraps the resolver with the permutation
model. The summary prints an `Executed:` line with the model ids the AI layer
actually ran and their call counts, and the run **fails loudly** if a `-m`
override never executed (that would be a silently-invalid comparison). Suites
whose sub-components intentionally use other models pass as long as the
requested model executed.

## Key Principle: Config Co-location (INV-44)

**Evals use production configuration by default.** Each AI component has a `config.ts` file co-located with its implementation. Both production code and evals import from the same config file.

```
src/agents/companion/config.ts      # Production config
src/services/stream-naming/config.ts
src/lib/boundary-extraction/config.ts
src/lib/memo/config.ts
```

This ensures evals test what actually runs in production. No "test model IDs" or "eval temperatures" that diverge from real behavior.

## YAML Config Files

For complex evaluation runs, use YAML config files instead of CLI flags.

### Basic Structure

```yaml
suites:
  - name: companion # Suite name (required)
    title: "My test" # Display name (optional)
    cases: # Filter to specific cases (optional)
      - case-id-001
      - case-id-002
    components: # Override component config (optional)
      companion:
        model: openrouter:anthropic/claude-haiku-4.5
        temperature: 0.5
```

### Multiple Permutations

Run the same suite with different configurations to compare:

```yaml
suites:
  # Default production config
  - name: companion
    title: "Production (Claude Sonnet 4.5)"

  # Same suite, different model
  - name: companion
    title: "Claude Haiku 4.5"
    components:
      companion:
        model: openrouter:anthropic/claude-haiku-4.5

  # Same suite, different provider
  - name: companion
    title: "gpt-5.4-nano"
    components:
      companion:
        model: openrouter:openai/gpt-5.4-nano
```

### Narrowing a config run

`-s` filters a config file's runs to one suite (`-r`, `--min-pass-rate` and
`--json` already applied in config mode). A comparison config often pairs suites
with different prerequisites — the `companion` half needs `TAVILY_API_KEY`, the
`persona-style` half does not — so running one half must not mean editing the
file that documents the comparison. An `-s` naming a suite the config has no
runs for is an error, not an empty run.

### Component Keys by Suite

Each suite supports specific component keys:

**companion**:

- `companion` - Main agent model
- `researcher` - Research subcomponent (if integrated)

**stream-naming**, **boundary-extraction**, **memo-classifier**, **memorizer**, **voice-polish**:

- Single model, use the suite name as the component key

### Example: Full Config File

```yaml
# Compare multiple models on companion suite
suites:
  - name: companion
    title: "Claude Sonnet 4.5 (production)"
    # No components = production defaults

  - name: companion
    title: "Claude Haiku 4.5"
    components:
      companion:
        model: openrouter:anthropic/claude-haiku-4.5
        temperature: 0.7

  - name: companion
    title: "gpt-5.4-nano"
    components:
      companion:
        model: openrouter:openai/gpt-5.4-nano
        temperature: 0.5

  # Run stream-naming with specific cases only
  - name: stream-naming
    title: "Technical conversations"
    cases:
      - technical-001
      - technical-002
```

## CLI Reference

```
bun run eval -- [options]

Options:
  -h, --help            Show help message
  -s, --suite <name>    Run specific suite
  -c, --case <id>       Run specific case(s), comma-separated
  -m, --model <ids>     Override model(s), comma-separated (runtime-verified)
  -t, --temperature <n> Override temperature (0.0-1.0)
  -p, --parallel <n>    Parallel workers (default: 1)
  -r, --runs <n>        Repeat every case n times, report per-case pass rates
  --min-pass-rate <n>   Pass-rate a case must clear when runs > 1 (default: 1.0)
  --json <file>         Write machine-readable results JSON to <file>
  --config <file>       Run from YAML config file
  -v, --verbose         Verbose output
```

## Writing New Suites

### 1. Create Suite Directory

```
evals/suites/my-suite/
├── index.ts      # Export suite
├── suite.ts      # Suite definition
├── cases.ts      # Test cases
├── types.ts      # Input/output types
└── evaluators.ts # Custom evaluators (optional)
```

### 2. Import Production Config

```typescript
// suite.ts
import { MY_MODEL_ID, MY_TEMPERATURE } from "../../../src/my-feature/config"

export const mySuite = defineSuite({
  name: "my-suite",
  description: "Tests my feature",
  defaultPermutations: [{ model: MY_MODEL_ID, temperature: MY_TEMPERATURE }],
  // ...
})
```

### 3. Define Test Cases

```typescript
// cases.ts
export const cases: TestCase[] = [
  {
    id: "basic-001",
    input: {
      /* ... */
    },
    expected: {
      /* ... */
    },
    evaluators: ["accuracy", "tone"],
  },
]
```

### 4. Register Suite

Add to `evals/run.ts`:

```typescript
import { mySuite } from "./suites/my-suite/suite"

const allSuites = [, /* existing */ mySuite]
```

## Output

Results are displayed in the terminal with:

- Per-case pass/fail status
- Evaluator scores
- Cost tracking (tokens and estimated cost)
- Comparison table for multi-model runs

## Environment Variables

| Variable             | Required | Description                                 |
| -------------------- | -------- | ------------------------------------------- |
| `OPENROUTER_API_KEY` | Yes      | API key for model calls                     |
| `TAVILY_API_KEY`     | Yes\*    | Tavily key for companion `web_search` evals |
| `DATABASE_URL`       | Yes      | PostgreSQL connection                       |

\* Required when running the `companion` suite, which now uses the real `web_search` tool path.
