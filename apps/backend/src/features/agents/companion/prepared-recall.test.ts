import { DisabledAnalyticsReporter, type AnalyticsEvent } from "@threahq/backend-common"
import { describe, expect, it, mock } from "bun:test"
import type { MemoExplorerResult, MemoExplorerService } from "../../memos"
import { PREPARED_RECALL_EVENT, PreparedRecall, formatRecalledMemosBlock } from "./prepared-recall"

function result(id: string, title: string): MemoExplorerResult {
  return {
    memo: {
      id,
      title,
      abstract: `${title} abstract`,
      knowledgeType: "context",
      sourceMessageIds: [] as string[],
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
  surface: "companion" as const,
  query: "What should I bring to the picnic?",
  accessibleStreamIds: new Set(["stream_pad"]),
  memoViewerUserId: "usr_1",
}

function recordingReporter() {
  const captureEvent = mock((_event: AnalyticsEvent) => {})
  return { reporter: Object.assign(new DisabledAnalyticsReporter(), { captureEvent }), captureEvent }
}

function outcomes(captureEvent: ReturnType<typeof recordingReporter>["captureEvent"]) {
  return captureEvent.mock.calls.map(([event]) => event.properties?.outcome)
}

describe("PreparedRecall", () => {
  it("keeps the memos a reply should use, best first, within the turn's audience", async () => {
    const search = mock(async (_params: Parameters<MemoExplorerService["search"]>[0]) => [
      result("memo_trivia", "Office plant schedule"),
      result("memo_allergy", "Peanut allergy"),
      result("memo_diet", "Vegetarian on weekdays"),
    ])
    const { reporter, captureEvent } = recordingReporter()
    const recall = new PreparedRecall({
      analyticsReporter: reporter,
      memoExplorerService: { search },
      scorer: { score: async () => [0.1, 1, 0.66] },
    })

    const { outcome, memos: recalled } = await recall.recall(params)

    expect({
      outcome,
      ids: recalled.map((memo) => memo.id),
      permissions: search.mock.calls[0]?.[0].permissions,
      events: captureEvent.mock.calls,
    }).toEqual({
      outcome: "recalled",
      ids: ["memo_allergy", "memo_diet"],
      permissions: { accessibleStreamIds: ["stream_pad"], userId: "usr_1" },
      events: [
        [
          {
            distinctId: "workspace:ws_1",
            event: PREPARED_RECALL_EVENT,
            properties: {
              surface: "companion",
              outcome: "recalled",
              candidateCount: 3,
              recalledCount: 2,
              durationMs: expect.any(Number),
              $process_person_profile: false,
            },
            groups: { workspace: "ws_1" },
          },
        ],
      ],
    })
  })

  it("recalls nothing, and counts it, when the candidates could not be scored", async () => {
    const { reporter, captureEvent } = recordingReporter()
    const recall = new PreparedRecall({
      analyticsReporter: reporter,
      memoExplorerService: { search: async () => [result("memo_allergy", "Peanut allergy")] },
      scorer: { score: async () => null },
    })

    expect({ recalled: await recall.recall(params), outcomes: outcomes(captureEvent) }).toEqual({
      recalled: { outcome: "unscored", memos: [] },
      outcomes: ["unscored"],
    })
  })

  it("goes on without recall when the search stalls or fails, counting each", async () => {
    const { reporter, captureEvent } = recordingReporter()
    const stalled = new PreparedRecall({
      analyticsReporter: reporter,
      memoExplorerService: { search: () => new Promise(() => {}) },
      scorer: { score: async () => [] },
      timeoutMs: 10,
    })
    const failing = new PreparedRecall({
      analyticsReporter: reporter,
      memoExplorerService: {
        search: async () => {
          throw new Error("db down")
        },
      },
      scorer: { score: async () => [] },
    })

    expect({
      stalled: await stalled.recall(params),
      failing: await failing.recall(params),
      outcomes: outcomes(captureEvent),
    }).toEqual({
      stalled: { outcome: "timeout", memos: [] },
      failing: { outcome: "failed", memos: [] },
      outcomes: ["timeout", "failed"],
    })
  })

  it("does not search for an empty message", async () => {
    const search = mock(async () => [])
    const recall = new PreparedRecall({
      analyticsReporter: new DisabledAnalyticsReporter(),
      memoExplorerService: { search },
      scorer: { score: async () => [] },
    })

    await recall.recall({ ...params, query: "   " })

    expect(search).not.toHaveBeenCalled()
  })
})

describe("formatRecalledMemosBlock", () => {
  it("renders each memo escaped, with its id and capture date, and nothing when none were recalled", async () => {
    const recall = new PreparedRecall({
      analyticsReporter: new DisabledAnalyticsReporter(),
      memoExplorerService: { search: async () => [result("memo_allergy", "Peanut <allergy>")] },
      scorer: { score: async () => [1] },
    })

    const block = formatRecalledMemosBlock((await recall.recall(params)).memos)

    expect({ block, empty: formatRecalledMemosBlock([]) }).toEqual({
      block: expect.stringContaining(
        '<memo id="memo_allergy" title="Peanut &lt;allergy&gt;" type="context" captured="2026-09-30">\nPeanut &lt;allergy&gt; abstract\n</memo>'
      ),
      empty: null,
    })
  })
})
