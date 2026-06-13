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

// Mirrors what the composer/API path emits: the canonical contentJson with
// structural mention nodes (INV-58); the markdown is just the wire serialization.
function mentionDoc(...slugs: string[]) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: slugs.flatMap((slug, i) => [
          { type: "text", text: i === 0 ? "hey " : " and " },
          { type: "mention", attrs: { id: `persona_${i}`, slug, mentionType: "persona" } },
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
          contentJson: "contentJson" in (overrides ?? {}) ? overrides!.contentJson : mentionDoc("ariadne"),
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

  it("dispatches one persona job per mentioned slug from contentJson nodes, deduped", async () => {
    const event = makeMessageCreatedEvent(1n, {
      contentMarkdown: "hey @ariadne and @ariadne",
      contentJson: mentionDoc("ariadne", "ariadne"),
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(PersonaRepository, "findBySlug").mockResolvedValue(ACTIVE_PERSONA as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

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

  it("dispatches for non-Latin slugs the markdown pattern used to miss (INV-54)", async () => {
    const event = makeMessageCreatedEvent(1n, {
      contentMarkdown: "hej @лена",
      contentJson: mentionDoc("лена"),
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const findBySlug = spyOn(PersonaRepository, "findBySlug").mockResolvedValue({
      ...ACTIVE_PERSONA,
      slug: "лена",
    } as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(findBySlug).toHaveBeenCalledWith(expect.anything(), "лена", "ws_test")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("dispatches nothing when contentJson is null, even if the markdown contains @-text", async () => {
    const event = makeMessageCreatedEvent(1n, {
      contentMarkdown: "hey @ariadne",
      contentJson: null,
    })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([event] as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const findBySlug = spyOn(PersonaRepository, "findBySlug").mockResolvedValue(ACTIVE_PERSONA as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(findBySlug).not.toHaveBeenCalled()
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
    spyOn(PersonaRepository, "findBySlug").mockResolvedValue(ACTIVE_PERSONA as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(send).not.toHaveBeenCalled()
  })

  it("skips non-user actors and E2E streams", async () => {
    const personaEvent = makeMessageCreatedEvent(1n, { actorType: AuthorTypes.PERSONA })
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([personaEvent] as any)
    const e2eSpy = spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    spyOn(PersonaRepository, "findBySlug").mockResolvedValue(ACTIVE_PERSONA as any)

    const { handler, send } = createHandler()
    handler.handle()
    await new Promise((r) => setTimeout(r, 300))

    expect(send).not.toHaveBeenCalled()
    expect(e2eSpy).toHaveBeenCalled()
  })
})
