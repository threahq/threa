/**
 * Parse and validate a `/eval` slash-command comment into a safe argv for the
 * eval CLI (`evals/run.ts`).
 *
 * Security: the comment body is attacker-influenced (anyone who can comment on
 * a PR). The GitHub workflow gates execution on write-permission, but this
 * parser is the second line of defence: it allowlists flags and character-
 * validates every value, so a crafted comment can never inject shell tokens or
 * unknown flags into the command line. Unknown tokens are a hard error, never
 * silently dropped (INV-11).
 */

/** Suite names accepted by `-s` — kept in sync with `run.ts` `allSuites`. */
export const EVAL_SUITES = [
  "companion",
  "stream-naming",
  "boundary-extraction",
  "multimodal-vision",
  "memo-classifier",
  "memorizer",
] as const

/** Default suite when the command names none — the cheap, high-signal one. */
export const DEFAULT_SUITE = "boundary-extraction"

/** Bounds that cap cost/latency of an on-demand run. */
export const MAX_RUNS = 12
export const MAX_MODELS = 4
export const MAX_PARALLEL = 8

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
// Model ids look like `openrouter:openai/gpt-5.4-mini`.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/

export interface ParsedEvalCommand {
  /** Sanitized argv to pass after `bun run eval --` (excludes infra flags). */
  args: string[]
  /** Normalized single-line command echoed back to the user. */
  echo: string
}

export class EvalCommandError extends Error {}

function intInRange(raw: string, flag: string, min: number, max: number): string {
  if (!/^\d+$/.test(raw)) throw new EvalCommandError(`\`${flag}\` expects an integer, got \`${raw}\`.`)
  const n = Number(raw)
  if (n < min || n > max) throw new EvalCommandError(`\`${flag}\` must be between ${min} and ${max}, got ${n}.`)
  return String(n)
}

/**
 * Split a comma-separated list value. Because the whole command is tokenized on
 * whitespace first, a space inside the list (`a, b`) would silently truncate it
 * — so an empty segment is a hard error pointing the user at the no-space form.
 */
function splitList(raw: string, label: string): string[] {
  const parts = raw.split(",")
  if (parts.some((p) => p === "")) {
    throw new EvalCommandError(`${label} list must be comma-separated with no spaces (got \`${raw}\`).`)
  }
  return parts
}

function unitFloat(raw: string, flag: string): string {
  if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(raw)) {
    throw new EvalCommandError(`\`${flag}\` must be a number between 0.0 and 1.0, got \`${raw}\`.`)
  }
  return raw
}

/**
 * Parse the first line of a `/eval …` comment. Throws `EvalCommandError` with a
 * user-facing message on anything invalid.
 */
export function parseEvalCommand(body: string): ParsedEvalCommand {
  const firstLine = (body ?? "").trim().split("\n")[0]?.trim() ?? ""
  const withoutPrefix = firstLine.replace(/^\/eval\b/, "")
  if (withoutPrefix === firstLine) {
    throw new EvalCommandError("Command must start with `/eval`.")
  }

  const tokens = withoutPrefix.split(/\s+/).filter(Boolean)

  let suite: string | undefined
  let cases: string | undefined
  let models: string | undefined
  let runs: string | undefined
  let parallel: string | undefined
  let temperature: string | undefined
  let minPassRate: string | undefined

  const takeValue = (flag: string, i: number): string => {
    const v = tokens[i + 1]
    if (v === undefined || v.startsWith("-")) throw new EvalCommandError(`\`${flag}\` requires a value.`)
    return v
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case "-s":
      case "--suite": {
        const v = takeValue(t, i++)
        if (!(EVAL_SUITES as readonly string[]).includes(v)) {
          throw new EvalCommandError(`Unknown suite \`${v}\`. Valid: ${EVAL_SUITES.join(", ")}.`)
        }
        suite = v
        break
      }
      case "-c":
      case "--case": {
        const ids = splitList(takeValue(t, i++), "Case")
        for (const id of ids) {
          if (!CASE_ID.test(id)) throw new EvalCommandError(`Invalid case id \`${id}\`.`)
        }
        cases = ids.join(",")
        break
      }
      case "-m":
      case "--model": {
        const ids = splitList(takeValue(t, i++), "Model")
        if (ids.length > MAX_MODELS) {
          throw new EvalCommandError(`At most ${MAX_MODELS} models can be compared at once (got ${ids.length}).`)
        }
        for (const id of ids) {
          if (!MODEL_ID.test(id)) throw new EvalCommandError(`Invalid model id \`${id}\`.`)
        }
        models = ids.join(",")
        break
      }
      case "-r":
      case "--runs":
        runs = intInRange(takeValue(t, i++), t, 1, MAX_RUNS)
        break
      case "-p":
      case "--parallel":
        parallel = intInRange(takeValue(t, i++), t, 1, MAX_PARALLEL)
        break
      case "-t":
      case "--temperature":
        temperature = unitFloat(takeValue(t, i++), t)
        break
      case "--min-pass-rate":
        minPassRate = unitFloat(takeValue(t, i++), t)
        break
      default:
        throw new EvalCommandError(`Unknown argument \`${t}\`. Supported: -s -c -m -r -p -t --min-pass-rate.`)
    }
  }

  const args: string[] = []
  args.push("-s", suite ?? DEFAULT_SUITE)
  if (cases) args.push("-c", cases)
  if (models) args.push("-m", models)
  if (runs) args.push("-r", runs)
  if (parallel) args.push("-p", parallel)
  if (temperature) args.push("-t", temperature)
  if (minPassRate) args.push("--min-pass-rate", minPassRate)

  return { args, echo: `/eval ${args.join(" ")}`.trim() }
}

// CLI entry: `bun run evals/slash/parse-args.ts` reads $EVAL_COMMAND, prints the
// sanitized args space-separated to stdout (safe: every token is charset-
// validated). On invalid input, prints the reason to stderr and exits 1.
if (import.meta.main) {
  try {
    const parsed = parseEvalCommand(process.env.EVAL_COMMAND ?? "")
    process.stdout.write(parsed.args.join(" "))
  } catch (error) {
    process.stderr.write(error instanceof EvalCommandError ? error.message : String(error))
    process.exit(1)
  }
}
