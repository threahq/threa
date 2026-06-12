import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { BotInvocationOutboxHandler } from "./invocation-outbox-handler"
import { BotRuntimeService } from "./service"
import {
  BotRuntimeInstanceRepository,
  BotRuntimeSessionLinkRepository,
  StreamActiveActorRepository,
} from "./repository"
import { StreamRepository } from "../streams"
import { BotRepository } from "../public-api/bot-repository"
import { PersonaRepository } from "../agents"
import { EventService } from "../messaging"
import * as outbox from "../../lib/outbox"
import { E2E_PLACEHOLDER_CONTENT_MARKDOWN } from "@threa/types"

afterEach(() => mock.restore())

const runProcessMessageCreated = async (payload: unknown): Promise<void> => {
  const handler = new BotInvocationOutboxHandler({} as Pool)
  // processMessageCreated is private; exercise it directly with a raw payload.
  await (handler as unknown as { processMessageCreated(p: unknown): Promise<void> }).processMessageCreated(payload)
}

const userMessagePayload = (params: { contentMarkdown: string; contentJson?: unknown }) => ({
  workspaceId: "ws_1",
  streamId: "stream_1",
  event: {
    id: "evt_1",
    sequence: "1",
    actorType: "user",
    actorId: "usr_1",
    payload: {
      messageId: "msg_1",
      contentMarkdown: params.contentMarkdown,
      ...(params.contentJson !== undefined && { contentJson: params.contentJson }),
    },
  },
})

const docWithText = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

const docWithMention = (slug: string) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "mention", attrs: { id: slug, slug, mentionType: "bot" } },
        { type: "text", text: " hi" },
      ],
    },
  ],
})

describe("BotInvocationOutboxHandler E2E short-circuit", () => {
  it("does not create any invocation for a message in an E2E stream", async () => {
    spyOn(outbox, "parseMessagePayload").mockReturnValue({
      streamId: "stream_1",
      workspaceId: "ws_1",
      event: {
        actorId: "usr_1",
        actorType: "user",
        payload: { messageId: "msg_1", contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN, contentJson: null },
      },
    } as never)
    const findById = spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_1",
      workspaceId: "ws_1",
      archivedAt: null,
      rootStreamId: null,
      e2eEnabled: true,
    } as never)
    const createInvocation = spyOn(BotRuntimeService.prototype, "createInvocation").mockResolvedValue({
      invocation: { id: "inv_1" },
      wasNewlyInserted: true,
    } as never)

    await runProcessMessageCreated({})

    expect(createInvocation).not.toHaveBeenCalled()
    // Returned at the E2E gate — never resolved the root stream (the next lookup).
    expect(findById).toHaveBeenCalledTimes(1)
  })
})

describe("BotInvocationOutboxHandler mention extraction (INV-54/INV-58)", () => {
  const channelStream = {
    id: "stream_1",
    workspaceId: "ws_1",
    archivedAt: null,
    rootStreamId: null,
    type: "channel",
    e2eEnabled: false,
  }

  it("dispatches a mention invocation from a contentJson mention node with a non-ASCII slug", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(channelStream as never)
    const findVisibleBySlugs = spyOn(BotRepository, "findVisibleBySlugs").mockResolvedValue([
      { id: "bot_1", slug: "аріадна", name: "Аріадна", archivedAt: null, traits: ["mentionable"] },
    ] as never)
    spyOn(PersonaRepository, "findBySlug").mockResolvedValue(null as never)
    const createInvocation = spyOn(BotRuntimeService.prototype, "createInvocation").mockResolvedValue({
      invocation: { id: "inv_1" },
      wasNewlyInserted: true,
    } as never)

    // The retired ASCII regex could never match this mention; the node can.
    await runProcessMessageCreated(
      userMessagePayload({ contentMarkdown: "@аріадна hi", contentJson: docWithMention("аріадна") })
    )

    expect(findVisibleBySlugs).toHaveBeenCalledWith({} as Pool, "ws_1", "usr_1", ["аріадна"])
    expect(createInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "bot_1",
        trigger: "mention",
        mentionedActorSlugs: ["аріадна"],
      })
    )
  })

  it("ignores @-shaped plain text that has no mention node", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(channelStream as never)
    const findVisibleBySlugs = spyOn(BotRepository, "findVisibleBySlugs").mockResolvedValue([] as never)
    const createInvocation = spyOn(BotRuntimeService.prototype, "createInvocation").mockResolvedValue({
      invocation: { id: "inv_1" },
      wasNewlyInserted: true,
    } as never)

    await runProcessMessageCreated(
      userMessagePayload({ contentMarkdown: "ping @scout", contentJson: docWithText("ping @scout") })
    )

    expect(findVisibleBySlugs).not.toHaveBeenCalled()
    expect(createInvocation).not.toHaveBeenCalled()
  })
})

describe("BotInvocationOutboxHandler active-scratchpad session-link policy", () => {
  const scratchpadStream = {
    id: "stream_1",
    workspaceId: "ws_1",
    archivedAt: null,
    rootStreamId: null,
    type: "scratchpad",
    e2eEnabled: false,
  }

  const activeBot = {
    id: "bot_1",
    slug: "scout",
    name: "Scout",
    archivedAt: null,
    traits: ["active-scratchpad"],
  }

  const setupActiveScratchpad = (params: {
    instance: { runtimeKind: string } | null
  }): {
    createInvocation: ReturnType<typeof spyOn>
    createMessage: ReturnType<typeof spyOn>
  } => {
    spyOn(StreamRepository, "findById").mockResolvedValue(scratchpadStream as never)
    spyOn(StreamActiveActorRepository, "findByRootStream").mockResolvedValue({
      actorType: "bot",
      actorId: "bot_1",
    } as never)
    spyOn(BotRepository, "findById").mockResolvedValue(activeBot as never)
    spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream").mockResolvedValue(null)
    spyOn(BotRuntimeInstanceRepository, "findLatestForBots").mockResolvedValue(
      (params.instance ? new Map([["bot_1", params.instance]]) : new Map()) as never
    )
    const createInvocation = spyOn(BotRuntimeService.prototype, "createInvocation").mockResolvedValue({
      invocation: { id: "inv_1" },
      wasNewlyInserted: true,
    } as never)
    const createMessage = spyOn(EventService.prototype, "createMessage").mockResolvedValue(undefined as never)
    return { createInvocation, createMessage }
  }

  const plainUserMessage = userMessagePayload({ contentMarkdown: "hello", contentJson: docWithText("hello") })

  it("posts the Pi notice and skips dispatch when an unlinked pi-local bot is active", async () => {
    const { createInvocation, createMessage } = setupActiveScratchpad({ instance: { runtimeKind: "pi-local" } })

    await runProcessMessageCreated(plainUserMessage)

    expect(createInvocation).not.toHaveBeenCalled()
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contentMarkdown: "**Scout is not linked to this scratchpad.** Run `/remote-control` in Pi to link a session.",
        metadata: { "bot_runtime.notice": "missing_session_link" },
      })
    )
  })

  it("defaults to the pi-local policy when the bot has no runtime instance", async () => {
    const { createInvocation, createMessage } = setupActiveScratchpad({ instance: null })

    await runProcessMessageCreated(plainUserMessage)

    expect(createInvocation).not.toHaveBeenCalled()
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { "bot_runtime.notice": "missing_session_link" } })
    )
  })

  it("dispatches an untargeted invocation without a notice for a link-free runtime kind", async () => {
    const { createInvocation, createMessage } = setupActiveScratchpad({ instance: { runtimeKind: "openclaw" } })

    await runProcessMessageCreated(plainUserMessage)

    expect(createMessage).not.toHaveBeenCalled()
    expect(createInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "bot_1",
        trigger: "active-scratchpad",
        targetInstanceId: null,
        targetRuntimeSessionId: null,
      })
    )
  })
})
