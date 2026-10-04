import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { TURN_DIGEST_INJECT_COUNT } from "@threahq/agent-runtime"
import type { TurnDigestStepContent } from "@threahq/types"
import { AgentSessionRepository, type AgentSessionStep, type RecentDigestStep } from "../session-repository"
import { buildTurnDigestPromptBlock, loadTurnDigestPromptBlock } from "./turn-digests"

function digestRow(over: {
  findings: string
  sourceStreamIds?: string[]
  sessionCreatedAt?: Date
  sessionCompletedAt?: Date | null
  content?: unknown
}): RecentDigestStep {
  const digest: TurnDigestStepContent = {
    findings: over.findings,
    toolsCalled: ["web_search"],
    sources: [],
    sourceStreamIds: over.sourceStreamIds ?? [],
  }
  const step: AgentSessionStep = {
    id: "step_1",
    sessionId: "session_1",
    stepNumber: 9,
    stepType: "turn_digest",
    content: over.content !== undefined ? over.content : JSON.stringify(digest),
    contentCiphertext: null,
    contentEnvelope: null,
    sources: null,
    messageId: null,
    tokensUsed: null,
    startedAt: new Date("2026-06-10T10:00:00.000Z"),
    completedAt: new Date("2026-06-10T10:00:01.000Z"),
  }
  return {
    step,
    sessionCreatedAt: over.sessionCreatedAt ?? new Date("2026-06-10T09:59:00.000Z"),
    sessionCompletedAt:
      over.sessionCompletedAt !== undefined ? over.sessionCompletedAt : new Date("2026-06-10T10:00:01.000Z"),
  }
}

describe("buildTurnDigestPromptBlock", () => {
  it("renders newest-first rows oldest-first with the session's completion time", () => {
    const block = buildTurnDigestPromptBlock(
      [
        digestRow({ findings: "Newest finding.", sessionCompletedAt: new Date("2026-06-11T08:00:00.000Z") }),
        digestRow({ findings: "Oldest finding.", sessionCompletedAt: new Date("2026-06-10T08:00:00.000Z") }),
      ],
      new Set<string>()
    ).text

    expect(block).toContain("## Prior Tool Work (Turn Digests)")
    expect(block!.indexOf("Oldest finding.")).toBeLessThan(block!.indexOf("Newest finding."))
    expect(block).toContain("Turn completed 2026-06-11T08:00:00.000Z")
  })

  it("drops a digest whose workspace source streams fell out of the current access set", () => {
    const { text: block, sourceStreamIds } = buildTurnDigestPromptBlock(
      [
        digestRow({ findings: "Still accessible.", sourceStreamIds: ["stream_ok", "stream_also_ok"] }),
        digestRow({ findings: "Also accessible.", sourceStreamIds: ["stream_ok"] }),
        digestRow({ findings: "Now private.", sourceStreamIds: ["stream_ok", "stream_revoked"] }),
      ],
      new Set(["stream_ok", "stream_also_ok"])
    )

    expect(block).toContain("Still accessible.")
    expect(block).toContain("Also accessible.")
    expect(block).not.toContain("Now private.")
    expect(sourceStreamIds.sort()).toEqual(["stream_also_ok", "stream_ok"])
  })

  it("injects only workspace-free digests on bot turns (no invoking user → no workspace access)", () => {
    const { text: block, sourceStreamIds } = buildTurnDigestPromptBlock(
      [
        digestRow({ findings: "Web-only digest." }),
        digestRow({ findings: "Workspace-derived digest.", sourceStreamIds: ["stream_x"] }),
      ],
      null
    )

    expect(block).toContain("Web-only digest.")
    expect(block).not.toContain("Workspace-derived digest.")
    expect(sourceStreamIds).toEqual([])
  })

  it("skips malformed digest content and returns null when nothing survives", () => {
    const empty = { text: null, sourceStreamIds: [] }
    expect(buildTurnDigestPromptBlock([digestRow({ findings: "unused", content: "not json" })], new Set())).toEqual(
      empty
    )
    expect(buildTurnDigestPromptBlock([], new Set())).toEqual(empty)
  })

  it("falls back to the session's created time when completion time is missing", () => {
    const block = buildTurnDigestPromptBlock(
      [
        digestRow({
          findings: "Finding.",
          sessionCompletedAt: null,
          sessionCreatedAt: new Date("2026-06-09T07:00:00.000Z"),
        }),
      ],
      new Set()
    ).text
    expect(block).toContain("Turn completed 2026-06-09T07:00:00.000Z")
  })
})

describe("loadTurnDigestPromptBlock", () => {
  afterEach(() => mock.restore())

  it("should read digests inside the caller's workspace", async () => {
    const find = spyOn(AgentSessionRepository, "findRecentDigestStepsByStream").mockResolvedValue([])

    await loadTurnDigestPromptBlock({} as never, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      personaId: "persona_1",
      accessibleStreamIds: null,
    })

    expect(find).toHaveBeenCalledWith(expect.anything(), "ws_1", {
      streamId: "stream_1",
      personaId: "persona_1",
      limit: TURN_DIGEST_INJECT_COUNT,
    })
  })
})
