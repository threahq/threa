import { describe, expect, it, mock } from "bun:test"
import type { MemoExplorerResult, MemoExplorerService } from "../../memos"
import { PreparedRecall, formatRecalledMemosBlock } from "./prepared-recall"

function result(id: string, title: string): MemoExplorerResult {
  return {
    memo: {
      id,
      title,
      abstract: `${title} abstract`,
      knowledgeType: "context",
      createdAt: new Date("2026-09-30T10:00:00Z"),
    },
    distance: 0,
    sourceStream: null,
    rootStream: null,
  } as MemoExplorerResult
}

const params = {
  workspaceId: "ws_1",
  invokingUserId: "usr_1",
  query: "What should I bring to the picnic?",
  accessibleStreamIds: new Set(["stream_pad"]),
  memoViewerUserId: "usr_1",
}

describe("PreparedRecall", () => {
  it("keeps the memos a reply should use, best first, within the turn's audience", async () => {
    const search = mock(async (_params: Parameters<MemoExplorerService["search"]>[0]) => [
      result("memo_trivia", "Office plant schedule"),
      result("memo_allergy", "Peanut allergy"),
      result("memo_diet", "Vegetarian on weekdays"),
    ])
    const recall = new PreparedRecall({
      memoExplorerService: { search },
      scorer: { score: async () => [0.1, 1, 0.66] },
    })

    const recalled = await recall.recall(params)

    expect({
      ids: recalled.map((memo) => memo.id),
      permissions: search.mock.calls[0]?.[0].permissions,
    }).toEqual({
      ids: ["memo_allergy", "memo_diet"],
      permissions: { accessibleStreamIds: ["stream_pad"], userId: "usr_1" },
    })
  })

  it("recalls nothing when the candidates could not be scored", async () => {
    const recall = new PreparedRecall({
      memoExplorerService: { search: async () => [result("memo_allergy", "Peanut allergy")] },
      scorer: { score: async () => null },
    })

    expect(await recall.recall(params)).toEqual([])
  })

  it("does not search for an empty message", async () => {
    const search = mock(async () => [])
    const recall = new PreparedRecall({ memoExplorerService: { search }, scorer: { score: async () => [] } })

    await recall.recall({ ...params, query: "   " })

    expect(search).not.toHaveBeenCalled()
  })
})

describe("formatRecalledMemosBlock", () => {
  it("renders each memo with its id and capture date, and nothing when none were recalled", async () => {
    const recall = new PreparedRecall({
      memoExplorerService: { search: async () => [result("memo_allergy", "Peanut <allergy>")] },
      scorer: { score: async () => [1] },
    })

    const block = formatRecalledMemosBlock(await recall.recall(params))

    expect({ block, empty: formatRecalledMemosBlock([]) }).toEqual({
      block: expect.stringContaining(
        '<memo id="memo_allergy" title="Peanut &lt;allergy&gt;" type="context" captured="2026-09-30">\nPeanut <allergy> abstract\n</memo>'
      ),
      empty: null,
    })
  })
})
