import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { CommandInfo, JSONContent } from "@threa/types"
import { spyOnExport } from "@/test"
import * as streamCommandsModule from "@/hooks/use-stream-commands"
import * as dispatchQueueModule from "@/hooks/use-command-dispatch-queue"
import * as discussModule from "@/hooks/use-discuss-with-ariadne"
import { useComposerCommandSend } from "./use-composer-command-send"

const COMMANDS: CommandInfo[] = [
  { name: "compact", description: "Compact the session" },
  { name: "steer", description: "Steer the agent" },
]

let queueCommand: ReturnType<typeof vi.fn>
let queuedFor: Array<string | undefined>

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
  spyOnExport(discussModule, "useDiscussWithAriadne").mockReturnValue((() => vi.fn()) as never)
})

function doc(...content: JSONContent[]): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content }] }
}

function hook(streamId: string | undefined = "stream_conversation") {
  return renderHook(() => useComposerCommandSend("ws_1", streamId)).result
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
})
