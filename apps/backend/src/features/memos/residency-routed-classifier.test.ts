import { describe, test, expect, mock } from "bun:test"
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

function createClassifier(options: { pinned: boolean; decisionsThrows?: boolean }) {
  const decisions = mock(async () => {
    if (options.decisionsThrows) throw new Error("decisions endpoint is unreachable")
    return DECISIONS
  })
  const inference = mock(async () => INFERENCE)
  const isPinned = mock(async () => options.pinned)

  const classifier = new ResidencyRoutedMemoClassifier({
    residency: { isPinned },
    decisions: { classifyConversation: decisions },
    inference: { classifyConversation: inference },
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
    const { classify, inference } = createClassifier({ pinned: false, decisionsThrows: true })

    expect({ result: await classify(), inferenceCalls: inference.mock.calls.length }).toEqual({
      result: INFERENCE,
      inferenceCalls: 1,
    })
  })
})
