import { describe, expect, it, mock } from "bun:test"
import { createModelRegistry, type CostRecorder } from "@threa/agent-runtime"
import { AnalyticsCostRecorder } from "./cost-recorder"

const EMBEDDING_MODEL = "openai/text-embedding-3-small"
const CHAT_MODEL = "anthropic/claude-sonnet-5"

function createRecorder() {
  const captureEvent = mock()
  const reporter = { captureEvent, captureException: mock(), shutdown: mock(async () => {}) }
  const inner: CostRecorder = { recordUsage: mock(async () => {}) }
  const recorder = new AnalyticsCostRecorder(inner, reporter as never, createModelRegistry())
  return { recorder, captureEvent, inner }
}

function usageParams(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws_1",
    userId: "usr_1",
    functionId: "companion-response",
    sessionId: "sess_1",
    model: CHAT_MODEL,
    provider: "openrouter",
    origin: "user" as const,
    usage: { promptTokens: 900, cachedPromptTokens: 700, completionTokens: 120, totalTokens: 1020, cost: 0.0042 },
    latencyMs: 2500,
    metadata: { streamId: "stream_1" },
    ...overrides,
  }
}

describe("AnalyticsCostRecorder", () => {
  it("should report a generation with the model, tokens, cost and latency when a chat call is recorded", async () => {
    const { recorder, captureEvent } = createRecorder()

    await recorder.recordUsage(usageParams())

    const [event] = captureEvent.mock.calls[0] as [Record<string, any>]
    expect(event).toEqual({
      distinctId: "workspace:ws_1",
      event: "$ai_generation",
      groups: { workspace: "ws_1" },
      properties: {
        $ai_trace_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        $ai_span_name: "companion-response",
        $ai_model: CHAT_MODEL,
        $ai_provider: "openrouter",
        $ai_input_tokens: 900,
        $ai_output_tokens: 120,
        $ai_cache_read_input_tokens: 700,
        $ai_total_cost_usd: 0.0042,
        $ai_latency: 2.5,
        $ai_session_id: "sess_1",
        ai_origin: "user",
        $process_person_profile: false,
      },
    })
  })

  it("should never report the prompt, the completion, the user or the telemetry metadata", async () => {
    const { recorder, captureEvent } = createRecorder()

    await recorder.recordUsage(usageParams())

    const [event] = captureEvent.mock.calls[0] as [Record<string, any>]
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain("usr_1")
    expect(serialized).not.toContain("stream_1")
    expect(event.properties.$ai_input).toBeUndefined()
    expect(event.properties.$ai_output_choices).toBeUndefined()
  })

  it("should report an embedding without output tokens when the model only outputs embeddings", async () => {
    const { recorder, captureEvent } = createRecorder()

    await recorder.recordUsage(
      usageParams({
        model: EMBEDDING_MODEL,
        functionId: "message-embedding",
        origin: "system",
        usage: { promptTokens: 40, totalTokens: 40, cost: 0.000002 },
        latencyMs: undefined,
      })
    )

    const [event] = captureEvent.mock.calls[0] as [Record<string, any>]
    expect(event.event).toBe("$ai_embedding")
    expect(event.properties.$ai_output_tokens).toBeUndefined()
    expect(event.properties.$ai_latency).toBeUndefined()
    expect(event.properties.$ai_input_tokens).toBe(40)
  })

  it("should pass the usage through to the wrapped cost recorder", async () => {
    const { recorder, inner } = createRecorder()
    const params = usageParams()

    await recorder.recordUsage(params)

    expect(inner.recordUsage).toHaveBeenCalledWith(params)
  })

  it("should give each call its own trace id", async () => {
    const { recorder, captureEvent } = createRecorder()

    await recorder.recordUsage(usageParams())
    await recorder.recordUsage(usageParams())

    const [first] = captureEvent.mock.calls[0] as [Record<string, any>]
    const [second] = captureEvent.mock.calls[1] as [Record<string, any>]
    expect(first.properties.$ai_trace_id).not.toBe(second.properties.$ai_trace_id)
  })
})
