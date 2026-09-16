import type { ModelSuggestionInfo, SessionControlActuator } from "@threahq/remote-session"
import { HermesApiError, type HermesRunsClient, type ModelOptions } from "./hermes-client"
import type { HermesTurnRunner } from "./run-bridge"

/** Threa catalog names only; the plan's "new conversation" is the catalog's `clear`. */
export const HERMES_SESSION_CONTROL_COMMANDS = ["stop", "steer", "status", "model", "clear"] as const

const MAX_AMBIGUOUS_CANDIDATES = 8

export interface HermesSessionControl extends SessionControlActuator {
  /** Load the model picker's options; awaited once before the session starts. */
  refresh(): Promise<void>
}

export interface ModelChoice {
  provider: string
  model: string
}

function choicesOf(options: ModelOptions): ModelChoice[] {
  return options.providers.flatMap((provider) => provider.models.map((model) => ({ provider: provider.slug, model })))
}

function label(choice: ModelChoice): string {
  return `${choice.provider}::${choice.model}`
}

/** Exact `provider::model`, then an unambiguous model id, then a case-insensitive substring. */
export function matchModel(choices: readonly ModelChoice[], arg: string): ModelChoice[] {
  const needle = arg.trim()
  if (needle.length === 0) return []
  const exactPair = choices.filter((choice) => label(choice) === needle)
  if (exactPair.length > 0) return exactPair
  const exactModel = choices.filter((choice) => choice.model === needle)
  if (exactModel.length === 1) return exactModel
  const lowered = needle.toLowerCase()
  return choices.filter((choice) => label(choice).toLowerCase().includes(lowered))
}

export function suggestionsFrom(options: ModelOptions): ModelSuggestionInfo[] {
  const names = new Map(options.providers.map((provider) => [provider.slug, provider.name ?? provider.slug]))
  return choicesOf(options).map((choice) => ({
    value: label(choice),
    label: choice.model,
    description: names.get(choice.provider) ?? choice.provider,
  }))
}

export function createHermesSessionControl(
  runner: HermesTurnRunner,
  client: HermesRunsClient,
  log: (message: string) => void = () => {}
): HermesSessionControl {
  let suggestions: ModelSuggestionInfo[] = []
  // Per conversation: /clear starts a conversation Hermes has no lock for,
  // so the lock is re-applied to the new one.
  const lockedModels = new Map<string, ModelChoice>()

  async function status(rootStreamId: string): Promise<string> {
    const conversationId = runner.conversationFor(rootStreamId)
    const lines = [`Conversation: \`${conversationId}\``]
    const open = runner.openRuns()
    if (open.length === 0) lines.push("No run is open.")
    else {
      for (const run of open) {
        const state = await client
          .getRun(run.runId)
          .then((result) => result.status)
          .catch((error) => `status unavailable: ${error instanceof Error ? error.message : String(error)}`)
        lines.push(`Run \`${run.runId}\` (${state})`)
      }
    }
    const lockedModel = lockedModels.get(conversationId)
    if (lockedModel) lines.push(`Model: \`${label(lockedModel)}\``)
    lines.push(`Gateway: ${client.baseUrl}`)
    return lines.join("\n")
  }

  async function setModel(
    arg: string,
    rootStreamId: string
  ): Promise<{ ok: boolean; summary?: string; message?: string }> {
    let options: ModelOptions
    try {
      options = await client.listModelOptions()
    } catch (error) {
      return { ok: false, message: `Could not read the Hermes model options: ${errorText(error)}` }
    }
    const matches = matchModel(choicesOf(options), arg)
    if (matches.length === 0) return { ok: false, message: `No model matches "${arg.trim()}".` }
    if (matches.length > 1) {
      const candidates = matches.slice(0, MAX_AMBIGUOUS_CANDIDATES).map(label)
      const more = matches.length > candidates.length ? ` (and ${matches.length - candidates.length} more)` : ""
      return { ok: false, message: `"${arg.trim()}" matches several models: ${candidates.join(", ")}${more}` }
    }
    const choice = matches[0]!
    const failure = await lockModel(runner.conversationFor(rootStreamId), choice)
    if (failure) return { ok: false, message: failure }
    return { ok: true, summary: `Set the model to ${label(choice)}` }
  }

  /** Lock a conversation to a model; returns the failure message, or undefined once locked. */
  async function lockModel(conversationId: string, choice: ModelChoice): Promise<string | undefined> {
    try {
      await client.createSession(conversationId)
    } catch (error) {
      // The conversation already exists once a turn has run in it.
      if (!(error instanceof HermesApiError && error.status === 409)) {
        return `Could not create the Hermes session: ${errorText(error)}`
      }
    }
    try {
      await client.lockSessionModel(conversationId, choice)
    } catch (error) {
      return `Could not set the model: ${errorText(error)}`
    }
    lockedModels.set(conversationId, choice)
    return undefined
  }

  // Commands act on the root conversation: the SDK hands a command only its root
  // stream, so a /clear typed in a thread clears the scratchpad's conversation.
  async function clear(rootStreamId: string): Promise<{ ok: boolean; summary?: string; message?: string }> {
    if (runner.openRuns().length > 0) {
      return { ok: false, message: "Stop the running turn first (/stop)." }
    }
    const previous = lockedModels.get(runner.conversationFor(rootStreamId))
    const conversationId = runner.bumpConversation(rootStreamId)
    if (!previous) return { ok: true, summary: "Started a new conversation" }
    const failure = await lockModel(conversationId, previous)
    if (failure) {
      return {
        ok: true,
        message: `Started a new conversation, but it runs on the gateway default model. ${failure}`,
      }
    }
    return { ok: true, summary: `Started a new conversation, model stays ${label(previous)}` }
  }

  return {
    commands: [...HERMES_SESSION_CONTROL_COMMANDS],
    get modelSuggestions() {
      return suggestions
    },
    interrupt: () => runner.interrupt(),
    steer: (text) => runner.steer(text),
    refresh: async () => {
      try {
        suggestions = suggestionsFrom(await client.listModelOptions())
      } catch (error) {
        log(`model options unavailable, /model will suggest nothing: ${errorText(error)}`)
        suggestions = []
      }
    },
    runCommand: async (name, args, context) => {
      switch (name) {
        case "status":
          return { ok: true, message: await status(context.rootStreamId) }
        case "model":
          return await setModel(args, context.rootStreamId)
        case "clear":
          return await clear(context.rootStreamId)
        default:
          return { ok: false, message: `The Hermes connector does not run /${name}.` }
      }
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
