import {
  discardCommandClaim,
  discardSpawnBrief,
  installedSpawnRuntimes,
  parseSpawnCommandArgs,
  prepareHarnessSpawn,
  writeCommandClaim,
  writeSpawnBrief,
  type SpawnRuntimeOption,
} from "@threahq/harness-client"
import {
  ThreaApiError,
  type BriefSessionBody,
  type ModelSuggestionInfo,
  type SessionControlActuator,
  type SessionControlInvocationContext,
} from "@threahq/remote-session"
import { errorText, type T3TurnRunner } from "./run-bridge"
import type { ModelOptionDescriptor, ModelSelection, ProviderInfo, T3Client } from "./t3-client"

const MAX_AMBIGUOUS_CANDIDATES = 8
/** Codex calls its effort setting `reasoningEffort`, Claude `effort`, Pi `thinking`. */
const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["reasoningEffort", "effort", "thinking"])
/** `/spawn t3code` launches a T3 thread of its own; every other runtime is harnessd's. */
const T3_SPAWN_RUNTIME = "t3code"

type CommandResult = Awaited<ReturnType<SessionControlActuator["runCommand"]>>

export interface T3SessionControlOptions {
  /** The bot's own Threa target. harnessd reports a handed-off `/spawn` there, since nothing else it reads knows it. */
  threa: { baseUrl: string; apiKey: string }
  spawnRuntimes: () => readonly SpawnRuntimeOption[]
  spawnLauncher?: typeof prepareHarnessSpawn
  /** Starts the turn that launches a `/spawn t3code`'s thread. */
  brief: (input: Pick<BriefSessionBody, "content" | "thread">) => Promise<unknown>
}

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

function effortOption(model: ProviderInfo["models"][number] | undefined): ModelOptionDescriptor | undefined {
  return model?.options?.find((option) => option.type === "select" && EFFORT_OPTION_IDS.has(option.id))
}

function effortOptionOf(
  providers: readonly ProviderInfo[],
  selection: ModelSelection
): ModelOptionDescriptor | undefined {
  return effortOption(
    providers
      .find((provider) => provider.providerInstanceId === selection.instanceId)
      ?.models.find((candidate) => candidate.id === selection.model)
  )
}

function effortOf(selection: ModelSelection | undefined): string | undefined {
  const value = selection?.options?.find((option) => EFFORT_OPTION_IDS.has(option.id))?.value
  return typeof value === "string" ? value : undefined
}

function described(selection: ModelSelection): string {
  const effort = effortOf(selection)
  return `\`${label(selection)}\`${effort ? `, thinking ${effort}` : ""}`
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

export function createT3SessionControl(
  runner: T3TurnRunner,
  client: T3Client,
  { threa, spawnRuntimes, spawnLauncher = prepareHarnessSpawn, brief }: T3SessionControlOptions
): T3SessionControl {
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

  async function status(streamId: string): Promise<string> {
    const threadId = runner.threadFor(streamId)
    const lines: string[] = []
    if (!threadId) lines.push("No T3 Code thread yet; the next message launches one.")
    else {
      const [read, configuration] = await Promise.allSettled([
        client.call("t3_thread_read", { threadId, limit: 1 }),
        client.call("t3_thread_configure", { threadId }),
      ])
      if (read.status === "fulfilled") {
        const { thread } = read.value
        const latestRun = thread.status !== "idle" && thread.latestRunId ? `, latest run \`${thread.latestRunId}\`` : ""
        lines.push(`Thread: ${thread.title} (\`${threadId}\`, ${thread.status}${latestRun})`)
      } else lines.push(`Thread: \`${threadId}\` (status unavailable: ${errorText(read.reason)})`)
      if (configuration.status === "fulfilled") {
        lines.push(`Model: ${described(configuration.value.modelSelection)}`)
        lines.push(`Access: ${configuration.value.runtimeMode}`)
      } else lines.push(`Model: unavailable (${errorText(configuration.reason)})`)
    }
    const open = runner.openRuns().map(({ runId, trace }) => {
      const waiting = trace.questions.size
      return waiting === 0
        ? `\`${runId}\``
        : `\`${runId}\` (waiting on ${waiting} ${waiting === 1 ? "answer" : "answers"})`
    })
    lines.push(open.length === 0 ? "No run is open." : `Open runs: ${open.join(", ")}`)
    if (runner.model) lines.push(`New threads launch on ${described(runner.model)}`)
    lines.push(`T3 Code: ${client.baseUrl}`)
    return lines.map((line) => `- ${line}`).join("\n")
  }

  // /model and /thinking move the scratchpad's thread and every later launch. The launch model is saved before this runs.
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

  /** The one model `arg` names, at the launch model's thinking level when it offers it. Needs fresh providers. */
  function pickModel(arg: string): { selection: ModelSelection } | CommandResult {
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
    return { selection: (effort !== undefined && withEffort(providers, choice, effort)) || choice }
  }

  /** `model` thinking at `arg`, matched case-insensitively. Needs fresh providers. */
  function pickThinking(
    model: ModelSelection,
    arg: string
  ): { selection: ModelSelection; level: string } | CommandResult {
    const levels = levelsOf(effortOptionOf(providers, model))
    if (levels.length === 0) return { ok: false, message: `${label(model)} has no thinking levels.` }
    const level = levels.find((candidate) => candidate.toLowerCase() === arg.trim().toLowerCase())
    const selection = level === undefined ? undefined : withEffort(providers, model, level)
    if (!level || !selection) return { ok: false, message: `${label(model)} thinks at one of: ${levels.join(", ")}.` }
    return { selection, level }
  }

  async function setModel(arg: string, rootStreamId: string): Promise<CommandResult> {
    const failure = await refreshProviders()
    if (failure) return failure
    const picked = pickModel(arg)
    if (!("selection" in picked)) return picked
    const { selection } = picked
    runner.setModel(selection)
    return await configureThread(runner.threadFor(rootStreamId), selection, `Set the model to ${label(selection)}`)
  }

  async function setThinking(arg: string, rootStreamId: string): Promise<CommandResult> {
    const model = runner.model
    if (!model) return { ok: false, message: "Pick a model with /model first." }
    const failure = await refreshProviders()
    if (failure) return failure
    const picked = pickThinking(model, arg)
    if (!("selection" in picked)) return picked
    const { selection: launch, level } = picked
    // A configure replaces the whole selection, and the thread may run another model than new threads launch on, like
    // one switched in T3, so the level goes onto the thread's own selection.
    const threadId = runner.threadFor(rootStreamId)
    let thread: ModelSelection | undefined
    if (threadId) {
      try {
        thread = (await client.call("t3_thread_configure", { threadId })).modelSelection
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

  async function compact(streamId: string): Promise<CommandResult> {
    const threadId = runner.threadFor(streamId)
    if (!threadId) return { ok: false, message: "No T3 Code thread to compact yet." }
    try {
      await runner.compact(streamId, threadId)
    } catch (error) {
      return { ok: false, message: `Could not compact \`${threadId}\`: ${errorText(error)}` }
    }
    return { ok: true, summary: "Queued a compaction of the T3 Code thread" }
  }

  function clear(streamId: string): CommandResult {
    if (runner.hasOpenTurns(streamId)) return { ok: false, message: "Stop the running turn first (/stop)." }
    runner.forgetThread(streamId)
    return { ok: true, summary: "Started a new T3 Code thread" }
  }

  /**
   * The picker row for `/spawn t3code`. Its levels span every model, since `/spawn t3code /model … /thinking …` may
   * pick one other than the launch model; the spawn itself checks the level against the model it launches.
   */
  function t3SpawnRuntime(): SpawnRuntimeOption {
    const levels = new Set(
      providers.flatMap((provider) => provider.models).flatMap((model) => levelsOf(effortOption(model)))
    )
    return {
      value: T3_SPAWN_RUNTIME,
      label: "T3 Code",
      installed: true,
      thinkingLevels: [...levels],
      models: suggestionsFrom(providers),
    }
  }

  function runtimes(): SpawnRuntimeOption[] {
    return [t3SpawnRuntime(), ...spawnRuntimes()]
  }

  async function spawn(args: string, context: SessionControlInvocationContext): Promise<CommandResult> {
    // The T3 Code row's thinking levels come from the models, so they must be current before the args are checked.
    const refreshFailure = await refreshProviders()
    const parsed = parseSpawnCommandArgs(args, { runtimes: runtimes(), defaultRuntime: T3_SPAWN_RUNTIME })
    if ("error" in parsed) return { ok: false, message: parsed.error }
    if (context.streamId !== context.rootStreamId) {
      return { ok: false, message: "Spawn is only available at the scratchpad itself, not inside a thread." }
    }
    if (parsed.runtime === T3_SPAWN_RUNTIME) {
      if (refreshFailure && (parsed.model || parsed.thinking)) return refreshFailure
      return await spawnT3(parsed, context.sourceMessageId)
    }
    // harnessd launches the agent in a thread under the user's `/spawn` and closes the command there itself.
    return {
      ok: true,
      handoffKeepsSessionRunning: true,
      handoff: async (claim) => {
        // Written on the handoff, so a handoff the session abandons leaves nothing behind. harnessd refuses a blank
        // brief, so an empty prompt gets no file.
        const briefFile = parsed.prompt ? writeSpawnBrief(parsed.prompt) : undefined
        const claimFile = writeCommandClaim({ runtime: "t3code", ...threa, ...claim })
        try {
          spawnLauncher({
            runtime: parsed.runtime,
            name: parsed.name,
            rootStreamId: context.rootStreamId,
            anchorId: context.sourceMessageId,
            briefFile,
            claimFile,
            ...(parsed.model ? { model: parsed.model } : {}),
            ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
          })()
        } catch (error) {
          discardCommandClaim(claimFile)
          discardSpawnBrief(briefFile)
          throw error
        }
      },
    }
  }

  async function spawnT3(
    { name, prompt, model: modelArg, thinking }: { name: string; prompt: string; model?: string; thinking?: string },
    anchorId: string
  ): Promise<CommandResult> {
    if (!prompt) return { ok: false, message: "T3 Code needs a prompt to start the thread." }
    let model = runner.model
    if (modelArg) {
      const picked = pickModel(modelArg)
      if (!("selection" in picked)) return picked
      model = picked.selection
    }
    if (thinking) {
      if (!model) return { ok: false, message: "Pick a model with /model first." }
      const picked = pickThinking(model, thinking)
      if (!("selection" in picked)) return picked
      model = picked.selection
    }
    try {
      runner.queueSpawn(anchorId, { title: name, ...(model ? { model } : {}) })
    } catch (error) {
      return { ok: false, message: errorText(error) }
    }
    try {
      await brief({ content: prompt, thread: { anchorId, displayName: name } })
    } catch (error) {
      // A timeout or server error may come after the brief was stored, and its turn still needs the pending spawn.
      if (!(error instanceof ThreaApiError) || error.status >= 500) {
        return { ok: false, message: `Could not confirm ${name} started: ${errorText(error)}` }
      }
      runner.dropSpawn(anchorId)
      return { ok: false, message: `Could not start ${name}: ${errorText(error)}` }
    }
    return { ok: true, summary: `Spawned ${name} in a new T3 Code thread` }
  }

  async function done(streamId: string, rootStreamId: string): Promise<CommandResult> {
    if (streamId === rootStreamId) return { ok: false, message: "/done is only available inside a thread." }
    const threadId = runner.threadFor(streamId)
    if (!threadId) return { ok: false, message: "This thread has no T3 Code thread to archive." }
    if (runner.hasOpenTurns(streamId)) return { ok: false, message: "Stop the running turn first (/stop)." }
    if (runner.isRelaying(streamId)) {
      return { ok: false, message: "T3 Code is running a turn it started itself here; try again once it finishes." }
    }
    try {
      await client.call("t3_thread_organize", { threadId, action: "archive" })
    } catch (error) {
      // T3 refuses to archive a thread archived in its own app, which would leave it linked for good.
      if (!(await isArchived(threadId))) {
        return { ok: false, message: `Could not archive \`${threadId}\`: ${errorText(error)}` }
      }
    }
    runner.forgetThread(streamId)
    return { ok: true, summary: `Archived the T3 Code thread \`${threadId}\`` }
  }

  async function isArchived(threadId: string): Promise<boolean> {
    try {
      return (await client.call("t3_thread_read", { threadId, limit: 1 })).thread.archived
    } catch {
      return false
    }
  }

  return {
    commands: ["attach", "stop", "status", "model", "thinking", "compact", "clear", "spawn", "done"],
    get spawnRuntimes() {
      return installedSpawnRuntimes(runtimes())
    },
    spawnDefaultRuntime: T3_SPAWN_RUNTIME,
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
        case "attach":
          try {
            return { ok: true, message: await runner.attach(context.streamId) }
          } catch (error) {
            return { ok: false, message: errorText(error) }
          }
        case "status":
          return { ok: true, message: await status(context.streamId) }
        case "model":
          return await setModel(args, context.rootStreamId)
        case "thinking":
          return await setThinking(args, context.rootStreamId)
        case "compact":
          return await compact(context.streamId)
        case "spawn":
          return await spawn(args, context)
        case "done":
          return await done(context.streamId, context.rootStreamId)
        // The SDK runs /stop itself and routes only the advertised commands here.
        case "clear":
        default:
          return clear(context.streamId)
      }
    },
  }
}
