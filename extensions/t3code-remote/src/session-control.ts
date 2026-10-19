import type { ModelSuggestionInfo, SessionControlActuator } from "@threahq/remote-session"
import { T3AuthError } from "./auth"
import { errorText, type T3TurnRunner } from "./run-bridge"
import type { ModelSelection, ProviderInfo, T3Client } from "./t3-client"

const MAX_AMBIGUOUS_CANDIDATES = 8

type CommandResult = { ok: boolean; summary?: string; message?: string }

export interface T3SessionControl extends SessionControlActuator {
  /** Load the model picker's options; awaited once before the session starts. */
  refresh(): Promise<void>
}

/** Exact `instance::model`, then an unambiguous model id, then a case-insensitive substring. */
export function matchModel(choices: readonly ModelSelection[], arg: string): ModelSelection[] {
  const needle = arg.trim()
  if (needle.length === 0) return []
  const exactPair = choices.filter((choice) => label(choice) === needle)
  if (exactPair.length > 0) return exactPair
  const exactModel = choices.filter((choice) => choice.model === needle)
  if (exactModel.length === 1) return exactModel
  const lowered = needle.toLowerCase()
  return choices.filter((choice) => label(choice).toLowerCase().includes(lowered))
}

function label(choice: ModelSelection): string {
  return `${choice.instanceId}::${choice.model}`
}

function choicesOf(providers: readonly ProviderInfo[]): ModelSelection[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({ instanceId: provider.providerInstanceId, model: model.id }))
  )
}

function suggestionsFrom(providers: readonly ProviderInfo[]): ModelSuggestionInfo[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: label({ instanceId: provider.providerInstanceId, model: model.id }),
      label: model.label ?? model.id,
      description: provider.displayName ?? provider.providerInstanceId,
    }))
  )
}

export function createT3SessionControl(
  runner: T3TurnRunner,
  client: T3Client,
  log: (message: string) => void = () => {}
): T3SessionControl {
  let suggestions: ModelSuggestionInfo[] = []

  async function status(rootStreamId: string): Promise<string> {
    const threadId = runner.threadFor(rootStreamId)
    const lines: string[] = []
    if (!threadId) lines.push("No T3 Code thread yet; the next message launches one.")
    else {
      try {
        const { thread } = await client.call("t3_thread_read", { threadId, limit: 1 })
        lines.push(`Thread: ${thread.title} (\`${threadId}\`, ${thread.status})`)
        lines.push(`Model: \`${thread.providerInstanceId}::${thread.model}\``)
      } catch (error) {
        lines.push(`Thread: \`${threadId}\` (status unavailable: ${errorText(error)})`)
      }
    }
    const open = runner.openRuns()
    lines.push(open.length === 0 ? "No run is open." : `Open runs: ${open.map((run) => `\`${run.runId}\``).join(", ")}`)
    if (runner.model) lines.push(`New threads launch on \`${label(runner.model)}\``)
    lines.push(`T3 Code: ${client.baseUrl}`)
    return lines.join("\n")
  }

  // The SDK hands a command only its root stream, so /model moves the scratchpad's thread and every later launch.
  async function setModel(arg: string, rootStreamId: string): Promise<CommandResult> {
    let providers: ProviderInfo[]
    try {
      providers = (await client.call("orchestrator_capabilities", {})).providers
    } catch (error) {
      return { ok: false, message: `Could not read the T3 Code models: ${errorText(error)}` }
    }
    const matches = matchModel(choicesOf(providers), arg)
    if (matches.length === 0) return { ok: false, message: `No model matches "${arg.trim()}".` }
    if (matches.length > 1) {
      const candidates = matches.slice(0, MAX_AMBIGUOUS_CANDIDATES).map(label)
      const more = matches.length > candidates.length ? ` (and ${matches.length - candidates.length} more)` : ""
      return { ok: false, message: `"${arg.trim()}" matches several models: ${candidates.join(", ")}${more}` }
    }
    const choice = matches[0]!
    runner.setModel(choice)
    const threadId = runner.threadFor(rootStreamId)
    if (threadId) {
      try {
        await client.call("t3_thread_configure", { threadId, modelSelection: choice })
      } catch (error) {
        return {
          ok: true,
          message: `New threads launch on ${label(choice)}, but \`${threadId}\` keeps its model: ${errorText(error)}`,
        }
      }
    }
    return { ok: true, summary: `Set the model to ${label(choice)}` }
  }

  // The SDK hands a command only its root stream, so a /clear typed in a thread clears the scratchpad's thread.
  function clear(rootStreamId: string): CommandResult {
    if (runner.hasOpenTurns(rootStreamId)) return { ok: false, message: "Stop the running turn first (/stop)." }
    runner.forgetThread(rootStreamId)
    return { ok: true, summary: "Started a new T3 Code thread" }
  }

  return {
    commands: ["stop", "status", "model", "clear"],
    get modelSuggestions() {
      return suggestions
    },
    interrupt: (streamId) => runner.interrupt(streamId),
    steer: (text, streamId) => runner.steer(text, streamId),
    refresh: async () => {
      try {
        suggestions = suggestionsFrom((await client.call("orchestrator_capabilities", {})).providers)
      } catch (error) {
        if (error instanceof T3AuthError) throw error
        log(`T3 Code models unavailable, /model will suggest nothing: ${errorText(error)}`)
        suggestions = []
      }
    },
    runCommand: async (name, args, context) => {
      switch (name) {
        case "status":
          return { ok: true, message: await status(context.rootStreamId) }
        case "model":
          return await setModel(args, context.rootStreamId)
        // The SDK runs /stop itself and routes only the advertised commands here.
        case "clear":
        default:
          return clear(context.rootStreamId)
      }
    },
  }
}
