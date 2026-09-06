import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { toast } from "sonner"
import { ASIDE_COMMAND, type CommandInfo, type JSONContent } from "@threahq/types"
import { spyOnExport } from "@/test"
import * as streamCommandsModule from "@/hooks/use-stream-commands"
import * as dispatchQueueModule from "@/hooks/use-command-dispatch-queue"
import * as openAsideModule from "@/hooks/use-open-aside"
import { useComposerCommandSend } from "./use-composer-command-send"

const COMMANDS: CommandInfo[] = [
  { name: "compact", description: "Compact the session" },
  { name: "steer", description: "Steer the agent" },
]

let queueCommand: ReturnType<typeof vi.fn>
let queuedFor: Array<string | undefined>
let openAside: ReturnType<typeof vi.fn>

beforeEach(() => {
  queueCommand = vi.fn().mockResolvedValue(undefined)
  queuedFor = []
  spyOnExport(streamCommandsModule, "useStreamCommands").mockReturnValue((() => COMMANDS) as never)
  spyOnExport(dispatchQueueModule, "useCommandDispatchQueue").mockReturnValue(((
    _workspaceId: string,
    streamId: string
  ) => {
    queuedFor.push(streamId)
    return { queueCommand }
  }) as never)
  openAside = vi.fn().mockResolvedValue(undefined)
  spyOnExport(openAsideModule, "useOpenAside").mockReturnValue((() => openAside) as never)
})

function doc(...content: JSONContent[]): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content }] }
}

function hook(streamId: string | undefined = "stream_conversation", conversationId?: string) {
  return renderHook(() => useComposerCommandSend("ws_1", streamId, conversationId)).result
}

describe("useComposerCommandSend planSend", () => {
  it("plans a dispatch for a slashCommand node", () => {
    const plan = hook().current.planSend(doc({ type: "slashCommand", attrs: { name: "compact" } }))
    expect(plan).toEqual({
      kind: "command",
      commandName: "compact",
      clientActionId: null,
      commandMarkdown: "/compact",
    })
  })

  it("plans a dispatch for raw text matching an available command", () => {
    const plan = hook().current.planSend(doc({ type: "text", text: "/compact " }))
    expect(plan).toEqual({
      kind: "command",
      commandName: "compact",
      clientActionId: null,
      commandMarkdown: "/compact",
    })
  })

  it("leaves unknown slash text as a normal message", () => {
    expect(hook().current.planSend(doc({ type: "text", text: "/nope please" }))).toBeNull()
  })

  it("keeps embedded steer on the message path and bare steer on the command path", () => {
    const embedded = hook().current.planSend(doc({ type: "text", text: "look here /steer" }))
    const bare = hook().current.planSend(doc({ type: "text", text: "/steer" }))
    expect({ embedded: embedded?.kind, bare }).toEqual({
      embedded: "steer-message",
      bare: { kind: "command", commandName: "steer", clientActionId: null, commandMarkdown: "/steer" },
    })
  })
})

describe("useComposerCommandSend dispatchCommand", () => {
  it("queues the command against the supplied stream", async () => {
    const result = hook()
    await result.current.dispatchCommand({
      kind: "command",
      commandName: "compact",
      clientActionId: null,
      commandMarkdown: "/compact",
    })
    expect({ queuedFor: queuedFor[0], call: queueCommand.mock.calls[0][0] }).toEqual({
      queuedFor: "stream_conversation",
      call: { commandMarkdown: "/compact", commandName: "compact" },
    })
  })

  it("stamps the composer's conversation on the dispatch so the card can draw the chip", async () => {
    const result = hook("stream_conversation", "conv_1")
    await result.current.dispatchCommand({
      kind: "command",
      commandName: "compact",
      clientActionId: null,
      commandMarkdown: "/compact",
    })
    expect(queueCommand.mock.calls[0][0]).toEqual({
      commandMarkdown: "/compact",
      commandName: "compact",
      conversationId: "conv_1",
    })
  })

  it("should open an aside beside the host stream for /aside from a timeline composer, never queueing a dispatch", async () => {
    await hook("stream_host").current.dispatchCommand({
      kind: "command",
      commandName: ASIDE_COMMAND,
      clientActionId: ASIDE_COMMAND,
      commandMarkdown: "/aside",
    })
    expect({ origin: openAside.mock.calls[0][0], queued: queueCommand.mock.calls.length }).toEqual({
      origin: { kind: "stream", hostStreamId: "stream_host" },
      queued: 0,
    })
  })

  it("should anchor /aside to the conversation from a board or panel composer", async () => {
    await hook("stream_root", "conv_1").current.dispatchCommand({
      kind: "command",
      commandName: ASIDE_COMMAND,
      clientActionId: ASIDE_COMMAND,
      commandMarkdown: "/aside",
    })
    expect(openAside.mock.calls[0][0]).toEqual({
      kind: "conversation",
      hostStreamId: "stream_root",
      conversationId: "conv_1",
    })
  })

  it("refuses a client action this build no longer has, instead of queueing it to the backend", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => "")
    await hook("stream_host").current.dispatchCommand({
      kind: "command",
      commandName: "discuss-with-ariadne",
      clientActionId: "discuss-with-ariadne",
      commandMarkdown: "/discuss-with-ariadne",
    })
    expect({ queued: queueCommand.mock.calls, toasts: error.mock.calls }).toEqual({
      queued: [],
      toasts: [["/discuss-with-ariadne isn't available any more."]],
    })
  })
})
