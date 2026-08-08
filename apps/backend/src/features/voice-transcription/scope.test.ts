import { describe, expect, it, mock, spyOn } from "bun:test"
import { createDecideVoiceBoundaryScope } from "./scope"
import { voicePolishConfig } from "./config"
import { logger } from "../../lib/logger"

const input = {
  currentRaw: "current",
  predecessorRaw: "raw prior",
  predecessorMarkdown: "Prior.",
  workspaceId: "ws",
  userId: "user",
  sessionId: "session",
  deadline: "live" as const,
}

describe("createDecideVoiceBoundaryScope", () => {
  it("uses generateObject with explicit medium reasoning and scope metadata", async () => {
    const generateObject = mock(async () => ({ value: { scope: "tail" } }))
    const logs: unknown[][] = []
    const info = spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args)
      return logger
    })
    const decide = createDecideVoiceBoundaryScope({ ai: { generateObject } as never })
    expect(await decide(input)).toEqual({ status: "success", scope: "tail" })
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: voicePolishConfig.maxTokens,
        reasoningEffort: "medium",
        telemetry: expect.objectContaining({
          functionId: "voice-transcript-boundary-scope",
          metadata: expect.objectContaining({ stage: "scope_live", sourceWindowCount: 2 }),
        }),
      })
    )
    expect(logs[0]?.[0]).toMatchObject({
      outcome: "success",
      scope: "tail",
      stage: "scope_live",
      protocolVersion: 4,
      sourceWindowCount: 2,
    })
    expect(JSON.stringify(logs)).not.toContain(input.currentRaw)
    info.mockRestore()
  })

  it("returns typed provider failure without exposing the provider error", async () => {
    const decide = createDecideVoiceBoundaryScope({
      ai: {
        generateObject: async () => {
          throw new Error("secret transcript")
        },
      } as never,
    })
    expect(await decide(input)).toEqual({ status: "provider_error" })
  })
})
