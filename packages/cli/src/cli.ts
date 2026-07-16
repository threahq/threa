#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { skillCommand } from "./commands/skill"
import { ThreaApiClient } from "./api-client"
import { TokenStore } from "./token-store"
import { attachmentsNoun } from "./commands/attachments"
import { conversationsNoun } from "./commands/conversations"
import { delegationsNoun } from "./commands/delegations"
import { whoamiCommand } from "./commands/identity"
import { labelsNoun } from "./commands/labels"
import { mcpCommand, serveMcp } from "./commands/mcp"
import { messagesNoun } from "./commands/messages"
import { memosNoun } from "./commands/memos"
import { searchCommand } from "./commands/search"
import { streamsNoun } from "./commands/streams"
import { usersNoun } from "./commands/users"
import { loadConfig } from "./config"
import {
  errorObject,
  formatSuccess,
  stderrJson,
  UsageError,
  withGlobalOptions,
  type CommandContext,
  type CommandSpec,
  type NounSpec,
  type VerbSpec,
} from "./output"
import { RefResolver } from "./resolver"

const FLAT_COMMANDS: CommandSpec[] = [whoamiCommand, searchCommand, skillCommand, mcpCommand]

const NOUNS: NounSpec[] = [
  messagesNoun,
  streamsNoun,
  conversationsNoun,
  usersNoun,
  memosNoun,
  attachmentsNoun,
  labelsNoun,
  delegationsNoun,
]

const FLAT_REGISTRY = new Map(FLAT_COMMANDS.map((c) => [c.name, c]))
const NOUN_REGISTRY = new Map(NOUNS.map((n) => [n.name, n]))

const SERVE_STUB = {} as CommandContext

/** Every top-level name, in a stable presentation order, with what it does. */
const TOP_ENTRIES: Array<{ name: string; summary: string; verbs?: string }> = [
  { name: whoamiCommand.name, summary: whoamiCommand.summary },
  ...NOUNS.map((n) => ({ name: n.name, summary: n.summary, verbs: n.verbs.map((v) => v.name).join(", ") })),
  { name: searchCommand.name, summary: searchCommand.summary },
  { name: skillCommand.name, summary: skillCommand.summary },
  { name: mcpCommand.name, summary: mcpCommand.summary },
]

function topHelp(): string {
  const width = Math.max(...TOP_ENTRIES.map((e) => e.name.length))
  const lines = TOP_ENTRIES.map((e) => {
    const verbs = e.verbs ? ` (${e.verbs})` : ""
    return `  ${e.name.padEnd(width)}  ${e.summary}${verbs}`
  })
  return [
    "threa — command-line access to a Threa workspace (one API key, bound via config).",
    "",
    "Usage: threa <command> [subcommand] [args] [flags]",
    "",
    "Commands:",
    ...lines,
    "",
    "Global flags: --json (force JSON output), --help (per-command help).",
    "Config: THREA_API_KEY and THREA_WORKSPACE_ID (env, or ~/.threa/mcp.json); THREA_BASE_URL optional.",
    "Run `threa <command> --help` for a command's subcommands or flags.",
  ].join("\n")
}

function nounHelp(noun: NounSpec): string {
  const width = Math.max(...noun.verbs.map((v) => v.name.length))
  const lines = noun.verbs.map((v) => `  ${v.name.padEnd(width)}  ${v.summary}`)
  return [
    `threa ${noun.name} <subcommand> [args] [flags]`,
    "",
    noun.summary,
    "",
    "Subcommands:",
    ...lines,
    "",
    `Run \`threa ${noun.name} <subcommand> --help\` for a subcommand's flags.`,
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

type Leaf = CommandSpec | VerbSpec

function leafFlags(leaf: Leaf): { serve: boolean; noConfig: boolean } {
  return {
    serve: (leaf as CommandSpec).serve === true,
    noConfig: (leaf as CommandSpec).noConfig === true,
  }
}

async function executeLeaf(leaf: Leaf, args: string[], deps: RunDeps, isTTY: boolean): Promise<RunResult> {
  let parsed
  try {
    parsed = parseArgs({
      args,
      options: withGlobalOptions(leaf.options),
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { exitCode: 2, stdout: "", stderr: stderrJson({ code: "USAGE", message, hint: leaf.usage }) }
  }

  const values = parsed.values as Record<string, unknown>
  const positionals = parsed.positionals

  if (values.help === true) {
    return { exitCode: 0, stdout: `${leaf.help}\n`, stderr: "" }
  }

  const { serve, noConfig } = leafFlags(leaf)
  try {
    if (serve) {
      await leaf.run(SERVE_STUB, positionals, values)
      return { exitCode: 0, stdout: "", stderr: "", serve: true }
    }
    if (noConfig) {
      const payload = await leaf.run(SERVE_STUB, positionals, values)
      return {
        exitCode: 0,
        stdout: `${formatSuccess(leaf, payload, { json: values.json === true, isTTY })}\n`,
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
    const payload = await leaf.run({ client, resolver, config, tokenStore, readStdin }, positionals, values)
    return {
      exitCode: 0,
      stdout: `${formatSuccess(leaf, payload, { json: values.json === true, isTTY })}\n`,
      stderr: "",
    }
  } catch (error) {
    if (error instanceof UsageError) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: stderrJson({ code: "USAGE", message: error.message, hint: leaf.usage }),
      }
    }
    return { exitCode: 1, stdout: "", stderr: stderrJson(errorObject(error)) }
  }
}

async function runNoun(noun: NounSpec, args: string[], deps: RunDeps, isTTY: boolean): Promise<RunResult> {
  const verbName = args[0]

  if (verbName === undefined) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: stderrJson({
        code: "USAGE",
        message: `"${noun.name}" needs a subcommand: ${noun.verbs.map((v) => v.name).join(", ")}`,
        hint: nounHelp(noun),
      }),
    }
  }

  if (verbName === "--help" || verbName === "-h") {
    return { exitCode: 0, stdout: `${nounHelp(noun)}\n`, stderr: "" }
  }

  const verb = noun.verbs.find((v) => v.name === verbName)
  if (!verb) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: stderrJson({
        code: "USAGE",
        message: `unknown ${noun.name} subcommand "${verbName}" — expected one of: ${noun.verbs
          .map((v) => v.name)
          .join(", ")}`,
        hint: nounHelp(noun),
      }),
    }
  }

  return executeLeaf(verb, args.slice(1), deps, isTTY)
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<RunResult> {
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY)

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { exitCode: 0, stdout: `${topHelp()}\n`, stderr: "" }
  }

  const name = argv[0]!

  const flat = FLAT_REGISTRY.get(name)
  if (flat) return executeLeaf(flat, argv.slice(1), deps, isTTY)

  const noun = NOUN_REGISTRY.get(name)
  if (noun) return runNoun(noun, argv.slice(1), deps, isTTY)

  return {
    exitCode: 2,
    stdout: "",
    stderr: stderrJson({ code: "UNKNOWN_COMMAND", message: `unknown command "${name}"`, hint: topHelp() }),
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
