import { describe, test, expect, mock } from "bun:test"
import { AISpendDeniedError, DecisionsAvailability } from "@threahq/agent-runtime"
import { ResidencyRoutedMemoClassifier } from "./residency-routed-classifier"
import type { ClassifiableConversation, ConversationClassification } from "./classifier"

const DECISIONS: ConversationClassification = {
  isKnowledgeWorthy: true,
  shouldReviseExisting: false,
  revisionReason: null,
  confidence: 0.92,
  containsActionItems: false,
}
const INFERENCE: ConversationClassification = { ...DECISIONS, confidence: 0.97, revisionReason: "new decision" }

const conversation: ClassifiableConversation = { id: "conv_test", topicSummary: null, participantIds: [] }

function createClassifier(options: { pinned: boolean; decisionsThrows?: Error; availability?: DecisionsAvailability }) {
  const decisions = mock(async () => {
    if (options.decisionsThrows) throw options.decisionsThrows
    return DECISIONS
  })
  const inference = mock(async () => INFERENCE)
  const isPinned = mock(async () => options.pinned)

  const classifier = new ResidencyRoutedMemoClassifier({
    residency: { isPinned },
    decisions: { classifyConversation: decisions },
    inference: { classifyConversation: inference },
    availability: options.availability ?? new DecisionsAvailability(),
  })

  const classify = () => classifier.classifyConversation(conversation, "<message/>", [], { workspaceId: "wsp_test" })

  return { classify, decisions, inference }
}

describe("ResidencyRoutedMemoClassifier", () => {
  test("a pinned workspace stays on inference and never reaches the decision model", async () => {
    const { classify, decisions, inference } = createClassifier({ pinned: true })

    expect({
      result: await classify(),
      decisionCalls: decisions.mock.calls.length,
      inferenceCalls: inference.mock.calls.length,
    }).toEqual({ result: INFERENCE, decisionCalls: 0, inferenceCalls: 1 })
  })

  test("an unpinned workspace uses the decision model", async () => {
    const { classify, decisions, inference } = createClassifier({ pinned: false })

    expect({
      result: await classify(),
      decisionCalls: decisions.mock.calls.length,
      inferenceCalls: inference.mock.calls.length,
    }).toEqual({ result: DECISIONS, decisionCalls: 1, inferenceCalls: 0 })
  })

  test("a failing decision call falls back to inference", async () => {
    const { classify, inference } = createClassifier({
      pinned: false,
      decisionsThrows: new Error("decisions endpoint is unreachable"),
    })

    expect({ result: await classify(), inferenceCalls: inference.mock.calls.length }).toEqual({
      result: INFERENCE,
      inferenceCalls: 1,
    })
  })

  test("a failed decision call holds the next conversation on inference for the cooldown", async () => {
    const availability = new DecisionsAvailability()
    const failing = createClassifier({
      pinned: false,
      decisionsThrows: new Error("decisions endpoint is unreachable"),
      availability,
    })
    const healthy = createClassifier({ pinned: false, availability })

    await failing.classify()

    expect({ result: await healthy.classify(), decisionCalls: healthy.decisions.mock.calls.length }).toEqual({
      result: INFERENCE,
      decisionCalls: 0,
    })
  })

  test("a spend denial is rethrown instead of answered by the more expensive path", async () => {
    const { classify, inference } = createClassifier({
      pinned: false,
      decisionsThrows: new AISpendDeniedError(
        { workspaceId: "wsp_test", functionId: "memo-classify-conversation" },
        "workspace_limit"
      ),
    })

    expect({
      rejected: await classify().then(
        () => null,
        (error) => error instanceof AISpendDeniedError
      ),
      inferenceCalls: inference.mock.calls.length,
    }).toEqual({ rejected: true, inferenceCalls: 0 })
  })
})
