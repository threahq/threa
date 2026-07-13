import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as cursorLockModule from "@threa/backend-common"
import type { ProcessResult } from "@threa/backend-common"
import { AuthorTypes } from "@threa/types"
import { OutboxRepository } from "../../lib/outbox"
import { E2eStreamsRepository } from "../e2e-streams"
import { PersonaRepository } from "./persona-repository"
import { MentionInvokeHandler } from "./mention-invoke-outbox-handler"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"

function makeFakeCursorLock(onRun?: (result: ProcessResult) => void) {
  return () => ({
    run: mock(async (processor: (cursor: bigint, processedIds: bigint[]) => Promise<ProcessResult>) => {
      const result = await processor(0n, [])
      onRun?.(result)
    }),
  })
}

function createHandler() {
  ;(spyOn(cursorLockModule, "CursorLock") as any).mockImplementation(makeFakeCursorLock())
  const send = mock(async () => {})
  const jobQueue = { send } as unknown as QueueManager
  const handler = new MentionInvokeHandler({} as any, jobQueue)
  return { handler, send }
}

// Mirrors what the composer/API path emits AFTER ingestion resolution (INV-64):
// mention nodes carry the resolved actor id as the authoritative reference; the
// slug is a display label. Each entry is `[personaId, slug]`.
function mentionDoc(...mentions: Array<[id: string, slug: string]>) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: mentions.flatMap(([id, slug], i) => [
          { type: "text", text: i === 0 ? "hey " : " and " },
          { type: "mention", attrs: { id, slug, mentionType: "persona" } },
        ]),
      },
    ],
  }
}

function makeMessageCreatedEvent(
  id: bigint,
  overrides?: {
    actorType?: string
    contentMarkdown?: string
    contentJson?: unknown
  }
) {
  return {
    id,
    eventType: "message:created" as const,
    payload: {
      workspaceId: "ws_test",
      streamId: "stream_test",
      event: {
        id: "event_1",
        sequence: "1",
        actorType: overrides?.actorType ?? AuthorTypes.USER,
        actorId: "usr_author",
        payload: {
          messageId: "msg_test",
          contentMarkdown: overrides?.contentMarkdown ?? "hey @ariadne",
          contentJson:
            "contentJson" in (overrides ?? {}) ? overrides!.contentJson : mentionDoc(["persona_ariadne", "ariadne"]),
        },
      },
    },
    createdAt: new Date(),
  }
}

const ACTIVE_PERSONA = { id: "persona_ariadne", slug: "ariadne", status: "active" }

describe("MentionInvokeHandler", () => {
  afterEach(() => {
    mock.restore()
  })

  it("dispatches one persona job per mentioned id from contentJson nodes, deduped", async () => {
    const event = makeMessageCreatedEvent(1n, {
      contentMarkdown: "hey @ariadne and @ariadne",
      contentJson: mentionDoc(["persona_ariadne", "ariadne"], ["persona_ariadne", "ariadne"]),
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const findByIds = spyOn(PersonaRepository, "findByIds").mockResolvedValue([ACTIVE_PERSONA] as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(findByIds).toHaveBeenCalledWith(expect.anything(), ["persona_ariadne"], "ws_test")
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(JobQueues.PERSONA_AGENT, {
      workspaceId: "ws_test",
      streamId: "stream_test",
      messageId: "msg_test",
      personaId: ACTIVE_PERSONA.id,
      triggeredBy: "usr_author",
      trigger: "mention",
    })
  })

  it("selects personas by resolved id regardless of slug script (INV-54)", async () => {
    const event = makeMessageCreatedEvent(1n, {
      contentMarkdown: "hej @лена",
      contentJson: mentionDoc(["persona_lena", "лена"]),
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const findByIds = spyOn(PersonaRepository, "findByIds").mockResolvedValue([
      { ...ACTIVE_PERSONA, id: "persona_lena", slug: "лена" },
    ] as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(findByIds).toHaveBeenCalledWith(expect.anything(), ["persona_lena"], "ws_test")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("ignores non-persona actor refs (user/bot/broadcast) in the same message", async () => {
    const event = makeMessageCreatedEvent(1n, {
      contentMarkdown: "hey @here @bob @ariadne @helper",
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { id: "broadcast:here", slug: "here", mentionType: "broadcast" } },
              { type: "mention", attrs: { id: "usr_bob", slug: "bob", mentionType: "user" } },
              { type: "mention", attrs: { id: "persona_ariadne", slug: "ariadne", mentionType: "persona" } },
              { type: "mention", attrs: { id: "bot_helper", slug: "helper", mentionType: "bot" } },
            ],
          },
        ],
      },
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const findByIds = spyOn(PersonaRepository, "findByIds").mockResolvedValue([ACTIVE_PERSONA] as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(findByIds).toHaveBeenCalledWith(expect.anything(), ["persona_ariadne"], "ws_test")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("dispatches nothing for an unresolved (bare-slug) mention id", async () => {
    const event = makeMessageCreatedEvent(1n, {
      contentMarkdown: "hey @ariadne",
      contentJson: mentionDoc(["ariadne", "ariadne"]),
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const findByIds = spyOn(PersonaRepository, "findByIds").mockResolvedValue([ACTIVE_PERSONA] as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(findByIds).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("skips inactive personas", async () => {
    const event = makeMessageCreatedEvent(1n)
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([{ ...ACTIVE_PERSONA, status: "archived" }] as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(send).not.toHaveBeenCalled()
  })

  it("dispatches nothing when contentJson is null, even if the markdown contains @-text", async () => {
    const event = makeMessageCreatedEvent(1n, {
      contentMarkdown: "hey @ariadne",
      contentJson: null,
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const findByIds = spyOn(PersonaRepository, "findByIds").mockResolvedValue([ACTIVE_PERSONA] as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(findByIds).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("ignores @-shaped plain text that carries no mention node", async () => {
    const event = makeMessageCreatedEvent(1n, {
      contentMarkdown: "email me at hello@ariadne.dev",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "email me at hello@ariadne.dev" }] }],
      },
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([ACTIVE_PERSONA] as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(send).not.toHaveBeenCalled()
  })

  it("dispatches a personal persona mentioned by its owner", async () => {
    // Author (actorId "usr_author") owns the personal persona.
    const event = makeMessageCreatedEvent(1n, {
      contentJson: mentionDoc(["persona_mine", "mine"]),
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([
      { id: "persona_mine", slug: "mine", status: "active", managedBy: "user", ownerUserId: "usr_author" },
    ] as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(JobQueues.PERSONA_AGENT, expect.objectContaining({ personaId: "persona_mine" }))
  })

  it("skips a personal persona mentioned by a non-owner while still dispatching other mentioned personas", async () => {
    const event = makeMessageCreatedEvent(1n, {
      contentJson: mentionDoc(["persona_theirs", "theirs"], ["persona_ariadne", "ariadne"]),
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([
      { id: "persona_theirs", slug: "theirs", status: "active", managedBy: "user", ownerUserId: "usr_someone_else" },
      { ...ACTIVE_PERSONA },
    ] as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    // The other user's personal persona is skipped; the workspace built-in still runs.
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      JobQueues.PERSONA_AGENT,
      expect.objectContaining({ personaId: "persona_ariadne" })
    )
  })

  it("skips non-user actors and E2E streams", async () => {
    const personaEvent = makeMessageCreatedEvent(1n, { actorType: AuthorTypes.PERSONA })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([personaEvent] as any)
    const e2eSpy = spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([ACTIVE_PERSONA] as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(send).not.toHaveBeenCalled()
    expect(e2eSpy).toHaveBeenCalled()
  })
})
