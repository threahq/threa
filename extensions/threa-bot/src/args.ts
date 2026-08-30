import { parseArgs } from "node:util"

export interface RunArgs {
  kind: "run"
  /** The agent command and its arguments; each turn is piped to its stdin. */
  command: string[]
  /** `scratchpad` links a scratchpad the command answers in; `mention` answers @mentions anywhere. */
  mode: "scratchpad" | "mention"
  /** Display-name prefix for the linked scratchpad. */
  name?: string
  /**
   * Names this session, so several can run in the same directory: identity
   * derives from host + directory + session, and re-running with the same
   * name resumes the same scratchpad. Unset = the directory is the session.
   */
  session?: string
  /** JSON config file merged under the environment. */
  config?: string
  /** Kill a turn's command after this long. */
  timeoutMs?: number
}

export interface ConnectArgs {
  kind: "connect"
  /** Threa origin to connect to; default https://app.threa.io. */
  baseUrl?: string
  /** Shown to the approver as the runtime's name. */
  name?: string
}

export type CliArgs = RunArgs | ConnectArgs | { kind: "help" } | { kind: "version" }

export const USAGE = `threa-bot connect [--base-url <url>] [--name <name>]
threa-bot run [options] -- <command> [args...]

connect prints a URL and a code; approve it in Threa and the bot key lands in
~/.threa/bot.json (override with THREA_BOT_CONFIG). run then needs nothing else.

run executes <command> once per turn with the turn's text on stdin. Its stdout
is the reply; stderr lines show up as trace steps in Threa.

Options (run):
  --mention          Answer @mentions in any stream instead of owning a scratchpad
  --name <prefix>    Scratchpad name prefix (default: the command's basename)
  --session <name>   Run several sessions in one directory; same name = same scratchpad
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
      session: { type: "string" },
      config: { type: "string" },
      timeout: { type: "string" },
      "base-url": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  })
  if (values.help) return { kind: "help" }
  if (values.version) return { kind: "version" }
  const [subcommand, ...rest] = positionals
  // Every option is parsed up front; the ones that belong to the other
  // subcommand are rejected rather than silently dropped.
  const rejectOptions = (names: string[]) => {
    for (const name of names) {
      const value = values[name as keyof typeof values]
      if (value !== undefined && value !== false) throw new Error(`--${name} does not apply to ${subcommand}`)
    }
  }
  if (subcommand === "connect") {
    if (rest.length > 0 || command.length > 0) throw new Error("connect takes no command")
    rejectOptions(["mention", "config", "timeout", "session"])
    return {
      kind: "connect",
      ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
      ...(values.name ? { name: values.name } : {}),
    }
  }
  if (subcommand !== "run") {
    throw new Error(subcommand ? `Unknown command: ${subcommand}` : "Missing command; expected `connect` or `run`.")
  }
  rejectOptions(["base-url"])
  if (rest.length > 0) throw new Error(`Unexpected argument before --: ${rest[0]}`)
  if (command.length === 0) throw new Error("Missing agent command: put it after `--`.")
  let timeoutMs: number | undefined
  if (values.timeout !== undefined) {
    timeoutMs = Number(values.timeout)
    // Above 2^31-1 ms Node's timers fire immediately.
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new Error("--timeout must be a positive integer of milliseconds up to 2147483647")
    }
  }
  return {
    kind: "run",
    command,
    mode: values.mention ? "mention" : "scratchpad",
    ...(values.name ? { name: values.name } : {}),
    ...(values.session?.trim() ? { session: values.session.trim() } : {}),
    ...(values.config ? { config: values.config } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}
