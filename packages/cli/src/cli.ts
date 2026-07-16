#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { skillCommand } from "./commands/skill"
import { ThreaApiClient } from "./api-client"
import { TokenStore } from "./token-store"
import { attachmentCommand } from "./commands/attachments"
import { conversationCommand, conversationsCommand } from "./commands/conversations"
import { delegationsCommand } from "./commands/delegations"
import { whoamiCommand } from "./commands/identity"
import { labelCommand, labelsCommand, unlabelCommand } from "./commands/labels"
import { mcpCommand, serveMcp } from "./commands/mcp"
import { deleteCommand, editCommand, findByMetadataCommand, sendCommand } from "./commands/messages"
import { memoCommand } from "./commands/memos"
import { searchCommand } from "./commands/search"
import { streamCommand, streamsCommand } from "./commands/streams"
import { usersCommand } from "./commands/users"
import { loadConfig } from "./config"
import {
  errorObject,
  formatSuccess,
  stderrJson,
  UsageError,
  withGlobalOptions,
  type CommandContext,
  type CommandSpec,
} from "./output"
import { RefResolver } from "./resolver"

const COMMANDS: CommandSpec[] = [
  whoamiCommand,
  streamsCommand,
  streamCommand,
  usersCommand,
  searchCommand,
  conversationsCommand,
  conversationCommand,
  findByMetadataCommand,
  memoCommand,
  attachmentCommand,
  sendCommand,
  editCommand,
  deleteCommand,
  labelsCommand,
  labelCommand,
  unlabelCommand,
  delegationsCommand,
  skillCommand,
  mcpCommand,
]

const REGISTRY = new Map(COMMANDS.map((c) => [c.name, c]))

const SERVE_STUB = {} as CommandContext

function topHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length))
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`)
  return [
    "threa — command-line access to a Threa workspace (one API key, bound via config).",
    "",
    "Usage: threa <command> [args] [flags]",
    "",
    "Commands:",
    ...lines,
    "",
    "Global flags: --json (force JSON output), --help (per-command help).",
    "Config: THREA_API_KEY and THREA_WORKSPACE_ID (env, or ~/.threa/mcp.json); THREA_BASE_URL optional.",
    "Run `threa <command> --help` for a command's flags.",
  ].join("\n")
}

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
  /** `mcp serve` runs a long-lived server the caller must start after run() returns. */
  serve?: boolean
}

export interface RunDeps {
  config?: import("./config").ThreaMcpConfig
  isTTY?: boolean
  readStdin?: () => Promise<string>
  tokenStore?: TokenStore
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<RunResult> {
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY)

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { exitCode: 0, stdout: `${topHelp()}\n`, stderr: "" }
  }

  const name = argv[0]!
  const spec = REGISTRY.get(name)
  if (!spec) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: stderrJson({ code: "UNKNOWN_COMMAND", message: `unknown command "${name}"`, hint: topHelp() }),
    }
  }

  let parsed
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options: withGlobalOptions(spec.options),
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { exitCode: 2, stdout: "", stderr: stderrJson({ code: "USAGE", message, hint: spec.usage }) }
  }

  const values = parsed.values as Record<string, unknown>
  const positionals = parsed.positionals

  if (values.help === true) {
    return { exitCode: 0, stdout: `${spec.help}\n`, stderr: "" }
  }

  try {
    if (spec.serve) {
      await spec.run(SERVE_STUB, positionals, values)
      return { exitCode: 0, stdout: "", stderr: "", serve: true }
    }
    if (spec.noConfig) {
      const payload = await spec.run(SERVE_STUB, positionals, values)
      return {
        exitCode: 0,
        stdout: `${formatSuccess(spec, payload, { json: values.json === true, isTTY })}\n`,
        stderr: "",
      }
    }
    const config = deps.config ?? loadConfig()
    const client = new ThreaApiClient({
      baseUrl: config.baseUrl,
      workspaceId: config.workspaceId,
      apiKey: config.apiKey,
    })
    const resolver = new RefResolver({ client })
    const readStdin = deps.readStdin ?? (() => Bun.stdin.text())
    const tokenStore = deps.tokenStore ?? new TokenStore()
    const payload = await spec.run({ client, resolver, config, tokenStore, readStdin }, positionals, values)
    return {
      exitCode: 0,
      stdout: `${formatSuccess(spec, payload, { json: values.json === true, isTTY })}\n`,
      stderr: "",
    }
  } catch (error) {
    if (error instanceof UsageError) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: stderrJson({ code: "USAGE", message: error.message, hint: spec.usage }),
      }
    }
    return { exitCode: 1, stdout: "", stderr: stderrJson(errorObject(error)) }
  }
}

async function main(): Promise<void> {
  const result = await run(process.argv.slice(2))
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.serve) {
    try {
      await serveMcp(loadConfig())
    } catch (error) {
      process.stderr.write(stderrJson(errorObject(error)))
      process.exit(1)
    }
    return
  }
  process.exit(result.exitCode)
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(stderrJson(errorObject(error)))
    process.exit(1)
  })
}
