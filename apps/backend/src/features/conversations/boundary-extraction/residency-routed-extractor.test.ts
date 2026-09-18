import { describe, test, expect, mock } from "bun:test"
import { ResidencyRoutedBoundaryExtractor } from "./residency-routed-extractor"
import type { BoundaryExtractor, ExtractionContext, ExtractionResult, SplitContext, SplitProposal } from "./types"

const DECISIONS_RESULT: ExtractionResult = {
  assignments: [{ conversationId: "conv_decisions", isPrimary: true }],
  confidence: 0.9,
}
const INFERENCE_RESULT: ExtractionResult = {
  assignments: [{ conversationId: "conv_inference", isPrimary: true }],
  confidence: 0.8,
}
const SPLIT_PROPOSAL: SplitProposal = { groups: [], confidence: 0.7, reasoning: "nothing to split" }

const context = { workspaceId: "wsp_test", streamType: "scratchpad" } as ExtractionContext

function createExtractor(options: { pinned: boolean; decisionsThrows?: boolean }) {
  const decisionsExtract = mock(async () => {
    if (options.decisionsThrows) throw new Error("decisions endpoint is unreachable")
    return DECISIONS_RESULT
  })
  const inferenceExtract = mock(async () => INFERENCE_RESULT)
  const splitConversation = mock(async () => SPLIT_PROPOSAL)
  const isPinned = mock(async () => options.pinned)

  const extractor = new ResidencyRoutedBoundaryExtractor({
    residency: { isPinned },
    decisions: { extract: decisionsExtract },
    inference: { extract: inferenceExtract, splitConversation } as unknown as BoundaryExtractor,
  })

  return { extractor, decisionsExtract, inferenceExtract, splitConversation, isPinned }
}

describe("ResidencyRoutedBoundaryExtractor", () => {
  test("a pinned workspace stays on inference and never reaches the decision model", async () => {
    const { extractor, decisionsExtract, inferenceExtract } = createExtractor({ pinned: true })

    const result = await extractor.extract(context)

    expect({
      result,
      decisionCalls: decisionsExtract.mock.calls.length,
      inferenceCalls: inferenceExtract.mock.calls.length,
    }).toEqual({
      result: INFERENCE_RESULT,
      decisionCalls: 0,
      inferenceCalls: 1,
    })
  })

  test("an unpinned workspace uses the decision model", async () => {
    const { extractor, decisionsExtract, inferenceExtract } = createExtractor({ pinned: false })

    const result = await extractor.extract(context)

    expect({
      result,
      decisionCalls: decisionsExtract.mock.calls.length,
      inferenceCalls: inferenceExtract.mock.calls.length,
    }).toEqual({
      result: DECISIONS_RESULT,
      decisionCalls: 1,
      inferenceCalls: 0,
    })
  })

  test("a failing decision call falls back to inference", async () => {
    const { extractor, inferenceExtract } = createExtractor({ pinned: false, decisionsThrows: true })

    const result = await extractor.extract(context)

    expect({ result, inferenceCalls: inferenceExtract.mock.calls.length }).toEqual({
      result: INFERENCE_RESULT,
      inferenceCalls: 1,
    })
  })

  test("splitting a conversation is inference on both paths", async () => {
    const splitContext = { workspaceId: "wsp_test" } as SplitContext
    const unpinned = createExtractor({ pinned: false })
    const pinned = createExtractor({ pinned: true })

    const results = [
      await unpinned.extractor.splitConversation(splitContext),
      await pinned.extractor.splitConversation(splitContext),
    ]

    expect({
      results,
      unpinnedSplits: unpinned.splitConversation.mock.calls.length,
      pinnedSplits: pinned.splitConversation.mock.calls.length,
      residencyChecks: unpinned.isPinned.mock.calls.length,
    }).toEqual({
      results: [SPLIT_PROPOSAL, SPLIT_PROPOSAL],
      unpinnedSplits: 1,
      pinnedSplits: 1,
      residencyChecks: 0,
    })
  })
})
