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
import { EventService } from "../messaging"
import { E2eStreamActorsRepository, E2eStreamsRepository } from "../e2e-streams"
import * as e2eStreams from "../e2e-streams"
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

// The ingestion resolver has already rewritten `attrs.id` to a prefixed actor
// id by the time this handler runs (INV-64); the slug is a display label only.
const docWithMention = (params: { id: string; slug: string; mentionType: string }) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "mention", attrs: { id: params.id, slug: params.slug, mentionType: params.mentionType } },
        { type: "text", text: " hi" },
      ],
    },
  ],
})

describe("BotInvocationOutboxHandler E2E delivery verdict", () => {
  it("skips an active-scratchpad bot on an E2E stream before any side effect — no invocation, no plaintext notice", async () => {
    spyOn(outbox, "parseMessagePayload").mockReturnValue({
      streamId: "stream_1",
      workspaceId: "ws_1",
      event: {
        actorId: "usr_1",
        actorType: "user",
        payload: { messageId: "msg_1", contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN, contentJson: null },
      },
    } as never)
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_1",
      workspaceId: "ws_1",
      archivedAt: null,
      rootStreamId: null,
      type: "scratchpad",
      e2eEnabled: true,
    } as never)
    spyOn(StreamActiveActorRepository, "findByRootStream").mockResolvedValue({
      actorType: "bot",
      actorId: "bot_1",
    } as never)
    spyOn(BotRepository, "findById").mockResolvedValue({
      id: "bot_1",
      slug: "scout",
      name: "Scout",
      archivedAt: null,
      traits: ["active-scratchpad"],
    } as never)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    spyOn(E2eStreamActorsRepository, "listForStream").mockResolvedValue([])
    const createInvocation = spyOn(BotRuntimeService.prototype, "createInvocation").mockResolvedValue({
      invocation: { id: "inv_1" },
      wasNewlyInserted: true,
    } as never)
    // The missing-link notice would be a plaintext system message — on an E2E
    // stream the verdict gate must fire before that write (INV-E1).
    const createMessage = spyOn(EventService.prototype, "createMessage").mockResolvedValue(undefined as never)
    const findActiveLink = spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream")

    await runProcessMessageCreated({})

    expect(createInvocation).not.toHaveBeenCalled()
    expect(createMessage).not.toHaveBeenCalled()
    expect(findActiveLink).not.toHaveBeenCalled()
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

  it("selects a mentioned bot by its resolved id and still carries the slug on the protocol field", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(channelStream as never)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const findVisibleByIds = spyOn(BotRepository, "findVisibleByIds").mockResolvedValue([
      { id: "bot_1", slug: "аріадна", name: "Аріадна", archivedAt: null, traits: ["mentionable"] },
    ] as never)
    const createInvocation = spyOn(BotRuntimeService.prototype, "createInvocation").mockResolvedValue({
      invocation: { id: "inv_1" },
      wasNewlyInserted: true,
    } as never)

    await runProcessMessageCreated(
      userMessagePayload({
        contentMarkdown: "@аріадна hi",
        contentJson: docWithMention({ id: "bot_1", slug: "аріадна", mentionType: "bot" }),
      })
    )

    expect(findVisibleByIds).toHaveBeenCalledWith({} as Pool, "ws_1", "usr_1", ["bot_1"])
    expect(createInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "bot_1",
        trigger: "mention",
        mentionedActorSlugs: ["аріадна"],
      })
    )
  })

  it("ignores an unresolved (bare-slug) mention node — selection never runs", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(channelStream as never)
    const findVisibleByIds = spyOn(BotRepository, "findVisibleByIds").mockResolvedValue([] as never)
    const createInvocation = spyOn(BotRuntimeService.prototype, "createInvocation").mockResolvedValue({
      invocation: { id: "inv_1" },
      wasNewlyInserted: true,
    } as never)

    await runProcessMessageCreated(
      userMessagePayload({
        contentMarkdown: "@scout hi",
        contentJson: docWithMention({ id: "scout", slug: "scout", mentionType: "bot" }),
      })
    )

    expect(findVisibleByIds).not.toHaveBeenCalled()
    expect(createInvocation).not.toHaveBeenCalled()
  })

  it("ignores @-shaped plain text that has no mention node", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(channelStream as never)
    const findVisibleByIds = spyOn(BotRepository, "findVisibleByIds").mockResolvedValue([] as never)
    const createInvocation = spyOn(BotRuntimeService.prototype, "createInvocation").mockResolvedValue({
      invocation: { id: "inv_1" },
      wasNewlyInserted: true,
    } as never)

    await runProcessMessageCreated(
      userMessagePayload({ contentMarkdown: "ping @scout", contentJson: docWithText("ping @scout") })
    )

    expect(findVisibleByIds).not.toHaveBeenCalled()
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
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
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

  it("dispatches when the verdict is sealed — the gate's sealed arm enqueues the turn (Phase 2.4)", async () => {
    const { createInvocation } = setupActiveScratchpad({ instance: { runtimeKind: "openclaw" } })
    // Force the sealed verdict — the policy switch is off in production, so this
    // is the only way to reach the gate's sealed arm. Without it (the gate
    // allowing plaintext alone) this dispatch would be denied.
    spyOn(e2eStreams, "resolveSealingContext").mockResolvedValue({
      streamIsE2e: true,
      actorHasGrant: true,
      externalSealedDelivery: true,
    })

    await runProcessMessageCreated(plainUserMessage)

    expect(createInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "bot_1", trigger: "active-scratchpad" })
    )
  })

  it("posts the Claude Code channel notice and skips dispatch when an unlinked claude-code-channel bot is active", async () => {
    const { createInvocation, createMessage } = setupActiveScratchpad({
      instance: { runtimeKind: "claude-code-channel" },
    })

    await runProcessMessageCreated(plainUserMessage)

    expect(createInvocation).not.toHaveBeenCalled()
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contentMarkdown: expect.stringContaining("Claude Code with the Threa channel"),
        metadata: { "bot_runtime.notice": "missing_session_link" },
      })
    )
  })

  // The active bot carries only `active-scratchpad` (not `mentionable`), so it is
  // never picked up by the mentionable-bot loop. Alongside a mentioned persona it
  // would normally be filtered out — it dispatches only because the gate matches
  // the active bot's resolved id against the mentioned ids (INV-64), not its slug.
  it("dispatches the active bot when it is explicitly mentioned by its resolved id", async () => {
    const { createInvocation } = setupActiveScratchpad({ instance: { runtimeKind: "openclaw" } })
    spyOn(BotRepository, "findVisibleByIds").mockResolvedValue([activeBot] as never)

    const mentionDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "bot_1", slug: "scout", mentionType: "bot" } },
            { type: "mention", attrs: { id: "persona_helper", slug: "helper", mentionType: "persona" } },
            { type: "text", text: " hi" },
          ],
        },
      ],
    }

    await runProcessMessageCreated(
      userMessagePayload({ contentMarkdown: "@scout @helper hi", contentJson: mentionDoc })
    )

    expect(createInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "bot_1",
        trigger: "active-scratchpad",
        mentionedActorSlugs: ["scout", "helper"],
      })
    )
  })
})
