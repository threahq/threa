import { describe, it, expect, mock, spyOn } from "bun:test"
import { createAI, AISpendDeniedError, type CostRecorder } from "./ai"
import {
  DECISIONS_ENDPOINT,
  choiceAnswer,
  noulAnswer,
  requestDecisions,
  rescaleScore,
  scoreAnswer,
  type DecisionsResult,
} from "./decisions"

/** Captured from a real `/api/alpha/decisions` call (typesafe/jev-1.13, 2026-09-18). */
const RESPONSE_BODY = {
  model: "typesafe/jev-1.13-20260917",
  answers: {
    kind: {
      type: "choice",
      choice: "decision",
      probabilities: { decision: 1, status: 0 },
      confidence: 1,
    },
    depth: {
      type: "score",
      score: 1.83,
      legend: { "0": "nothing", "1": "a hint", "2": "the gist", "3": "fully worked out" },
      probabilities: { "0": 0, "1": 0.17, "2": 0.83, "3": 0 },
      confidence: 0.82,
    },
    actionable: { type: "noul", noul: 0.19 },
  },
  usage: { input_tokens: 409, output_tokens: 63, cost: 0.000017178 },
  id: "gen-dec-1789764626-gWuG4UShK8znNJGxGMjG",
  provider: "TypeSafe",
}

const QUESTIONS = {
  kind: {
    type: "choice" as const,
    instructions: "What is `note.text`?",
    criteria: { decision: "A choice they committed to.", status: "A passing state." },
  },
  depth: {
    type: "score" as const,
    instructions: "How complete is `note.text` as a record?",
    criteria: ["nothing", "a hint", "the gist", "fully worked out"],
  },
  actionable: { type: "noul" as const, instructions: "Does `note.text` commit someone to a task?" },
}

const STATE = { note: { text: "We decided to move the scheduler to Postgres advisory locks." } }

function stubDecisions(body: unknown = RESPONSE_BODY, status = 200) {
  return spyOn(globalThis, "fetch").mockImplementation(
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch
  )
}

describe("generateDecisions", () => {
  it("sends the decisions protocol and returns every answer with usage", async () => {
    const fetchSpy = stubDecisions()
    try {
      const ai = createAI({ openrouter: { apiKey: "test-key" } })
      const result = await ai.generateDecisions({
        model: "openrouter:typesafe/jev-1.13",
        state: STATE,
        questions: QUESTIONS,
      })

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(DECISIONS_ENDPOINT)
      expect({
        method: init.method,
        authorization: (init.headers as Record<string, string>).Authorization,
        body: JSON.parse(init.body as string),
      }).toEqual({
        method: "POST",
        authorization: "Bearer test-key",
        body: { model: "typesafe/jev-1.13", state: STATE, questions: QUESTIONS },
      })

      expect(result).toEqual({
        answers: RESPONSE_BODY.answers as DecisionsResult["answers"],
        usage: { promptTokens: 409, completionTokens: 63, totalTokens: 472, cost: 0.000017178 },
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("records usage against the workspace", async () => {
    const fetchSpy = stubDecisions()
    try {
      const recordUsage = mock<CostRecorder["recordUsage"]>(async () => {})
      const ai = createAI({ openrouter: { apiKey: "test-key" }, costRecorder: { recordUsage } })
      await ai.generateDecisions({
        model: "openrouter:typesafe/jev-1.13",
        state: STATE,
        questions: QUESTIONS,
        context: { workspaceId: "ws_123" },
        telemetry: { functionId: "boundary-extract", metadata: { streamId: "stream_1" } },
      })

      const [call] = recordUsage.mock.calls[0]
      expect({
        workspaceId: call.workspaceId,
        functionId: call.functionId,
        model: call.model,
        provider: call.provider,
        origin: call.origin,
        usage: call.usage,
        metadata: call.metadata,
      }).toEqual({
        workspaceId: "ws_123",
        functionId: "boundary-extract",
        model: "typesafe/jev-1.13",
        provider: "openrouter",
        origin: "system",
        usage: { promptTokens: 409, completionTokens: 63, totalTokens: 472, cost: 0.000017178 },
        metadata: { streamId: "stream_1" },
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("is denied by the spend gate before the provider is called", async () => {
    const fetchSpy = stubDecisions()
    try {
      const ai = createAI({
        openrouter: { apiKey: "test-key" },
        spendGate: { admit: async () => ({ allowed: false as const, reason: "workspace_limit" as const }) },
      })
      const call = ai.generateDecisions({
        model: "openrouter:typesafe/jev-1.13",
        state: STATE,
        questions: QUESTIONS,
        context: { workspaceId: "ws_123" },
        telemetry: { functionId: "boundary-extract" },
      })

      await expect(call).rejects.toBeInstanceOf(AISpendDeniedError)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("throws with the provider's message on a non-2xx", async () => {
    const fetchSpy = stubDecisions({ error: { message: "model not found" } }, 404)
    try {
      const ai = createAI({ openrouter: { apiKey: "test-key" } })
      const call = ai.generateDecisions({
        model: "openrouter:typesafe/jev-1.13",
        state: STATE,
        questions: QUESTIONS,
      })
      await expect(call).rejects.toThrow(/404.*model not found/)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("gives up on a provider that stops answering", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })) as unknown as typeof globalThis.fetch)
    try {
      const call = requestDecisions({
        apiKey: "test-key",
        modelId: "typesafe/jev-1.13",
        state: STATE,
        questions: QUESTIONS,
        timeoutMs: 10,
      })
      await expect(call).rejects.toMatchObject({ name: "TimeoutError" })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("throws rather than return a half-parsed answer when the shape changes", async () => {
    const fetchSpy = stubDecisions({ answers: { kind: { type: "choice", choice: "decision" } }, usage: {} })
    try {
      const ai = createAI({ openrouter: { apiKey: "test-key" } })
      const call = ai.generateDecisions({
        model: "openrouter:typesafe/jev-1.13",
        state: STATE,
        questions: QUESTIONS,
      })
      await expect(call).rejects.toThrow(/did not match the expected shape/)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe("decision answer accessors", () => {
  const result: DecisionsResult = {
    answers: RESPONSE_BODY.answers as DecisionsResult["answers"],
    usage: {},
  }

  it("reads each answer type", () => {
    expect({
      choice: choiceAnswer(result, "kind").choice,
      score: rescaleScore(scoreAnswer(result, "depth"), 4, 7),
      noul: noulAnswer(result, "actionable"),
    }).toEqual({ choice: "decision", score: (1.83 / 3) * 7, noul: 0.19 })
  })

  it("throws when a question went unanswered", () => {
    expect(() => choiceAnswer(result, "missing")).toThrow(/"missing" is missing/)
  })

  it("throws when the answer is a different question type", () => {
    expect(() => noulAnswer(result, "kind")).toThrow(/is a choice question, expected noul/)
  })
})
