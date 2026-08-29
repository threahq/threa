import { parseArgs } from "node:util"

export interface RunArgs {
  kind: "run"
  /** The agent command and its arguments; each turn is piped to its stdin. */
  command: string[]
  /** `scratchpad` links a scratchpad the command answers in; `mention` answers @mentions anywhere. */
  mode: "scratchpad" | "mention"
  /** Display-name prefix for the linked scratchpad. */
  name?: string
  /** JSON config file merged under the environment. */
  config?: string
  /** Kill a turn's command after this long. */
  timeoutMs?: number
}

export type CliArgs = RunArgs | { kind: "help" } | { kind: "version" }

export const USAGE = `threa-bot run [options] -- <command> [args...]

Runs <command> once per turn with the turn's text on stdin. Its stdout is the
reply; stderr lines show up as trace steps in Threa.

Options:
  --mention          Answer @mentions in any stream instead of owning a scratchpad
  --name <prefix>    Scratchpad name prefix (default: the command's basename)
  --config <file>    JSON config file; environment variables win over it
  --timeout <ms>     Kill the command if a turn runs longer than this
  -h, --help         Show this help
  -v, --version      Print the version

Environment:
  THREA_WORKSPACE_ID   Workspace id (ws_…)
  THREA_API_KEY        A bot key (threa_bk_…)
  THREA_BASE_URL       Default https://app.threa.io

Examples:
  threa-bot run -- my-agent --answer
  threa-bot run --mention -- sh -c 'cat | tr a-z A-Z'`

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const split = argv.indexOf("--")
  const own = split === -1 ? [...argv] : argv.slice(0, split)
  const command = split === -1 ? [] : argv.slice(split + 1)
  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      mention: { type: "boolean", default: false },
      name: { type: "string" },
      config: { type: "string" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  })
  if (values.help) return { kind: "help" }
  if (values.version) return { kind: "version" }
  const [subcommand, ...rest] = positionals
  if (subcommand !== "run") {
    throw new Error(subcommand ? `Unknown command: ${subcommand}` : "Missing command; expected `run`.")
  }
  if (rest.length > 0) throw new Error(`Unexpected argument before --: ${rest[0]}`)
  if (command.length === 0) throw new Error("Missing agent command: put it after `--`.")
  let timeoutMs: number | undefined
  if (values.timeout !== undefined) {
    timeoutMs = Number(values.timeout)
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout must be a positive integer (ms)")
  }
  return {
    kind: "run",
    command,
    mode: values.mention ? "mention" : "scratchpad",
    ...(values.name ? { name: values.name } : {}),
    ...(values.config ? { config: values.config } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}
