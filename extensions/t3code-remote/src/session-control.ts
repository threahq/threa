import type { ModelSuggestionInfo, SessionControlActuator } from "@threahq/remote-session"
import { errorText, type T3TurnRunner } from "./run-bridge"
import type { ModelOptionDescriptor, ModelSelection, ProviderInfo, T3Client } from "./t3-client"

const MAX_AMBIGUOUS_CANDIDATES = 8
/** Codex calls its effort setting `reasoningEffort`, Claude `effort`, Pi `thinking`. */
const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["reasoningEffort", "effort", "thinking"])

type CommandResult = { ok: boolean; summary?: string; message?: string }

export interface T3SessionControl extends SessionControlActuator {
  /** Load the model picker's options; rejects when they could not be loaded. */
  loadOptions(): Promise<void>
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

function effortOptionOf(
  providers: readonly ProviderInfo[],
  selection: ModelSelection
): ModelOptionDescriptor | undefined {
  const model = providers
    .find((provider) => provider.providerInstanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.id === selection.model)
  return model?.options?.find((option) => option.type === "select" && EFFORT_OPTION_IDS.has(option.id))
}

function effortOf(selection: ModelSelection | undefined): string | undefined {
  const value = selection?.options?.find((option) => EFFORT_OPTION_IDS.has(option.id))?.value
  return typeof value === "string" ? value : undefined
}

function levelsOf(option: ModelOptionDescriptor | undefined): string[] {
  return option?.options?.map((level) => level.id) ?? []
}

/** The selection thinking at `level`, keeping its other options, or undefined when its model doesn't offer the level. */
function withEffort(
  providers: readonly ProviderInfo[],
  selection: ModelSelection,
  level: string
): ModelSelection | undefined {
  const option = effortOptionOf(providers, selection)
  if (!option || !levelsOf(option).includes(level)) return undefined
  const others = (selection.options ?? []).filter((candidate) => candidate.id !== option.id)
  return { ...selection, options: [...others, { id: option.id, value: level }] }
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

export function createT3SessionControl(runner: T3TurnRunner, client: T3Client): T3SessionControl {
  let providers: ProviderInfo[] = []

  /** Re-reads the models T3 offers; returns the failure to report when it can't. */
  async function refreshProviders(): Promise<CommandResult | undefined> {
    try {
      providers = (await client.call("orchestrator_capabilities", {})).providers
    } catch (error) {
      return { ok: false, message: `Could not read the T3 Code models: ${errorText(error)}` }
    }
    return undefined
  }

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
    if (runner.model) {
      const effort = effortOf(runner.model)
      lines.push(`New threads launch on \`${label(runner.model)}\`${effort ? `, thinking ${effort}` : ""}`)
    }
    lines.push(`T3 Code: ${client.baseUrl}`)
    return lines.map((line) => `- ${line}`).join("\n")
  }

  // The SDK hands a command only its root stream, so /model and /thinking move the scratchpad's thread and every
  // later launch. The launch model is saved before this runs.
  async function configureThread(
    threadId: string | undefined,
    selection: ModelSelection,
    summary: string
  ): Promise<CommandResult> {
    if (!threadId) return { ok: true, summary }
    try {
      await client.call("t3_thread_configure", { threadId, modelSelection: selection })
    } catch (error) {
      return { ok: true, message: `${summary} for new threads, but \`${threadId}\` keeps its own: ${errorText(error)}` }
    }
    return { ok: true, summary }
  }

  async function setModel(arg: string, rootStreamId: string): Promise<CommandResult> {
    const failure = await refreshProviders()
    if (failure) return failure
    const matches = matchModel(choicesOf(providers), arg)
    if (matches.length === 0) return { ok: false, message: `No model matches "${arg.trim()}".` }
    if (matches.length > 1) {
      const candidates = matches.slice(0, MAX_AMBIGUOUS_CANDIDATES).map(label)
      const more = matches.length > candidates.length ? ` (and ${matches.length - candidates.length} more)` : ""
      return { ok: false, message: `"${arg.trim()}" matches several models: ${candidates.join(", ")}${more}` }
    }
    const choice = matches[0]!
    // The thinking level carries over when the new model offers it; otherwise the model's default applies.
    const effort = effortOf(runner.model)
    const selection = (effort !== undefined && withEffort(providers, choice, effort)) || choice
    runner.setModel(selection)
    return await configureThread(runner.threadFor(rootStreamId), selection, `Set the model to ${label(choice)}`)
  }

  async function setThinking(arg: string, rootStreamId: string): Promise<CommandResult> {
    const model = runner.model
    if (!model) return { ok: false, message: "Pick a model with /model first." }
    const failure = await refreshProviders()
    if (failure) return failure
    const levels = levelsOf(effortOptionOf(providers, model))
    if (levels.length === 0) return { ok: false, message: `${label(model)} has no thinking levels.` }
    const level = levels.find((candidate) => candidate.toLowerCase() === arg.trim().toLowerCase())
    const launch = level === undefined ? undefined : withEffort(providers, model, level)
    if (!level || !launch) return { ok: false, message: `${label(model)} thinks at one of: ${levels.join(", ")}.` }
    // A configure replaces the whole selection, and the thread may run another model than new threads launch on, like
    // one switched in T3, so the level goes onto the thread's own selection.
    const threadId = runner.threadFor(rootStreamId)
    let thread: ModelSelection | undefined
    if (threadId) {
      try {
        thread = (await client.call("t3_thread_configuration", { threadId })).modelSelection
      } catch (error) {
        return { ok: false, message: `Could not read \`${threadId}\`'s model: ${errorText(error)}` }
      }
    }
    runner.setModel(launch)
    const summary = `Set thinking to ${level}`
    if (!threadId || !thread) return { ok: true, summary }
    const next = withEffort(providers, thread, level)
    if (!next) {
      return {
        ok: true,
        message: `${summary} for new threads, but \`${threadId}\` runs ${label(thread)}, which doesn't offer it.`,
      }
    }
    return await configureThread(threadId, next, summary)
  }

  // The SDK hands a command only its root stream, so a /clear typed in a thread clears the scratchpad's thread.
  function clear(rootStreamId: string): CommandResult {
    if (runner.hasOpenTurns(rootStreamId)) return { ok: false, message: "Stop the running turn first (/stop)." }
    runner.forgetThread(rootStreamId)
    return { ok: true, summary: "Started a new T3 Code thread" }
  }

  return {
    commands: ["stop", "status", "model", "thinking", "clear"],
    get modelSuggestions() {
      return suggestionsFrom(providers)
    },
    get thinkingLevels() {
      return runner.model ? levelsOf(effortOptionOf(providers, runner.model)) : []
    },
    interrupt: (streamId) => runner.interrupt(streamId),
    steer: (text, streamId, attachments, options) => runner.steer(text, streamId, attachments, options),
    loadOptions: async () => {
      providers = (await client.call("orchestrator_capabilities", {})).providers
    },
    runCommand: async (name, args, context) => {
      switch (name) {
        case "status":
          return { ok: true, message: await status(context.rootStreamId) }
        case "model":
          return await setModel(args, context.rootStreamId)
        case "thinking":
          return await setThinking(args, context.rootStreamId)
        // The SDK runs /stop itself and routes only the advertised commands here.
        case "clear":
        default:
          return clear(context.rootStreamId)
      }
    },
  }
}
