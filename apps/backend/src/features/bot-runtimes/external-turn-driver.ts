import {
  TurnDeliveries,
  declaredUnsupported,
  type DispatchedTurnDriver,
  type DispatchedTurnRequest,
  type TurnDelivery,
  type TurnDispatchBinding,
  type TurnDispatchReceipt,
  type TurnSinkResolution,
} from "@threa/agent-runtime"
import type { BotRuntimeService } from "./service"

/**
 * The external driver: hands the turn to a third-party harness over the bot
 * wire. `dispatchTurn` is a thin wrapper over `BotRuntimeService.createInvocation`
 * — it returns once the `bot_invocations` row exists and
 * `bot_invocation:available` is on the outbox. The harness claims the row,
 * streams `/steps`, and `/complete`s in later, separate requests, so the sink
 * edges are realized by those durable verb handlers, never inside this call.
 * Long-lived — construct once with the feature's service.
 */
export class ExternalTurnDriver implements DispatchedTurnDriver {
  readonly delivery: TurnDelivery = TurnDeliveries.EXTERNAL

  // How the TurnSink vocabulary lands on the external wire: commit and trace
  // resolve through the durable verbs; the rest are structural gaps of the
  // pull-based transport, declared with renderable reasons instead of omitted.
  readonly sinkResolution: TurnSinkResolution = {
    commitMessage: { realizedBy: "completeBotInvocation (POST .../bot-invocations/{invocationId}/complete)" },
    observers: { realizedBy: "recordBotInvocationStep (POST .../bot-invocations/{invocationId}/steps)" },
    shouldAbort: declaredUnsupported("cancellation toward an external runner has no carrier yet"),
    toolSignalProvider: declaredUnsupported("the harness drives its own tools"),
    newMessages: declaredUnsupported("third-party harnesses don't receive mid-turn messages"),
  }

  constructor(private readonly deps: { service: BotRuntimeService }) {}

  async dispatchTurn(request: DispatchedTurnRequest, binding: TurnDispatchBinding): Promise<TurnDispatchReceipt> {
    if (request.delivery !== this.delivery) {
      throw new Error(`ExternalTurnDriver serves "${this.delivery}" turns; got "${request.delivery}"`)
    }
    const { invocation, wasNewlyInserted } = await this.deps.service.createInvocation({
      workspaceId: binding.workspaceId,
      rootStreamId: binding.rootStreamId,
      activeStreamId: binding.activeStreamId,
      sourceMessageId: binding.sourceMessageId,
      responseStreamId: binding.responseStreamId,
      actorId: binding.actorId,
      trigger: binding.trigger,
      requiredCapability: binding.requiredCapability,
      promptMarkdown: extractPromptMarkdown(request),
      authorUserId: binding.authorUserId,
      mentionedActorSlugs: binding.mentionedActorSlugs,
      targetInstanceId: binding.targetInstanceId,
      targetRuntimeSessionId: binding.targetRuntimeSessionId,
      metadata: binding.metadata,
    })
    return { invocationId: invocation.id, status: wasNewlyInserted ? "dispatched" : "deduplicated" }
  }
}

/**
 * A dispatched request carries exactly the trigger prompt: the harness brings
 * its own model and tools, and history reaches it via the claim payload. More
 * than one message — or non-plain-text content — means a caller tried to ship
 * loop inputs across the wire, which must fail loudly (INV-11) rather than be
 * silently flattened into `promptMarkdown`.
 */
function extractPromptMarkdown(request: DispatchedTurnRequest): string {
  const [prompt, ...rest] = request.messages
  if (!prompt || rest.length > 0 || prompt.role !== "user" || typeof prompt.content !== "string") {
    throw new Error("external dispatch carries a single plain-text user prompt; history rides the claim payload")
  }
  return prompt.content
}
