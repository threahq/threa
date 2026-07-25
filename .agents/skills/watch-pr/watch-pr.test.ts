import { describe, expect, test } from "bun:test"
import {
  currentStatuses,
  diffSnapshots,
  isTransientPollError,
  pullNumbersForBranch,
  repositoryFromRemote,
  type Snapshot,
} from "./watch-pr"

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    capturedAt: "2026-01-01T00:00:00Z",
    repository: "acme/widgets",
    number: 42,
    title: "Add widget",
    body: "Description",
    state: "open",
    merged: false,
    mergedAt: null,
    closedAt: null,
    draft: false,
    mergeable: true,
    mergeableState: "clean",
    headSha: "abc",
    baseRef: "main",
    headRef: "feature",
    updatedAt: "2026-01-01T00:00:00Z",
    url: "https://github.com/acme/widgets/pull/42",
    comments: [],
    reviews: [],
    reviewThreads: [],
    checks: [],
    statuses: [],
    ...overrides,
  }
}

describe("repositoryFromRemote", () => {
  test.each([
    ["git@github.com:acme/widgets.git", "acme/widgets"],
    ["https://github.com/acme/widgets.git", "acme/widgets"],
    ["http://proxy@127.0.0.1:1234/git/acme/widgets", "acme/widgets"],
  ])("parses %s", (remote, expected) => {
    expect(repositoryFromRemote(remote)).toBe(expected)
  })
})

describe("PR inference", () => {
  test("matches a fork PR by branch without assuming its owner", () => {
    expect(
      pullNumbersForBranch(
        [
          { number: 41, head: { ref: "other" } },
          { number: 42, head: { ref: "feature" } },
        ],
        "feature"
      )
    ).toEqual([42])
  })
})

describe("currentStatuses", () => {
  test("keeps only the newest status per context", () => {
    const statuses = [
      { id: 1, context: "deploy", state: "pending", updatedAt: "2026-01-01T00:00:00Z" },
      { id: 2, context: "deploy", state: "success", updatedAt: "2026-01-01T00:01:00Z" },
      { id: 3, context: "lint", state: "success", updatedAt: "2026-01-01T00:00:00Z" },
    ]
    expect(currentStatuses(statuses).map(({ id }) => id)).toEqual([2, 3])
  })
})

describe("poll errors", () => {
  test("retries transport errors but not arbitrary failures", () => {
    expect(isTransientPollError(new TypeError("fetch failed"))).toBe(true)
    expect(isTransientPollError(new Error("invalid response"))).toBe(false)
  })
})

describe("diffSnapshots", () => {
  test("ignores observation and aggregate update timestamps", () => {
    expect(
      diffSnapshots(
        snapshot(),
        snapshot({
          capturedAt: "2026-01-01T00:01:00Z",
          updatedAt: "2026-01-01T00:01:00Z",
        })
      )
    ).toEqual([])
  })

  test("reports added and edited comments with full context", () => {
    const original = snapshot({
      comments: [
        {
          id: "1",
          kind: "issue",
          author: "reviewer",
          body: "old",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          url: "https://github.com/acme/widgets/pull/42#issuecomment-1",
        },
      ],
    })
    const changed = snapshot({
      comments: [
        { ...original.comments[0], body: "edited", updatedAt: "2026-01-01T00:02:00Z" },
        {
          id: "2",
          kind: "review",
          author: "coderabbitai",
          body: "Finding",
          createdAt: "2026-01-01T00:03:00Z",
          updatedAt: "2026-01-01T00:03:00Z",
          url: "https://github.com/acme/widgets/pull/42#discussion_r2",
          path: "src/widget.ts",
          line: 9,
          inReplyToId: null,
        },
      ],
    })

    expect(diffSnapshots(original, changed)).toEqual([
      {
        resource: "comment",
        action: "updated",
        id: "issue:1",
        before: original.comments[0],
        after: changed.comments[0],
      },
      { resource: "comment", action: "added", id: "review:2", after: changed.comments[1] },
    ])
  })

  test("distinguishes a merge from a manual close", () => {
    const before = snapshot()
    const after = snapshot({
      state: "closed",
      merged: true,
      mergedAt: "2026-01-01T00:04:00Z",
      closedAt: "2026-01-01T00:04:00Z",
    })
    expect(diffSnapshots(before, after)[0]).toMatchObject({
      resource: "pull_request",
      action: "updated",
      after: { state: "closed", merged: true, mergedAt: "2026-01-01T00:04:00Z" },
    })
  })

  test("reports check transitions and resolved threads", () => {
    const check = {
      id: 7,
      name: "test",
      app: "github-actions",
      status: "in_progress",
      conclusion: null,
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: null,
      url: "https://github.com/acme/widgets/actions/runs/1",
    }
    const thread = { id: "T1", resolved: false, outdated: false, path: "src/widget.ts", line: 2, comments: [] }
    const before = snapshot({ checks: [check], reviewThreads: [thread] })
    const after = snapshot({
      checks: [{ ...check, status: "completed", conclusion: "success", completedAt: "2026-01-01T00:04:00Z" }],
      reviewThreads: [{ ...thread, resolved: true }],
    })

    expect(diffSnapshots(before, after).map(({ resource, action, id }) => ({ resource, action, id }))).toEqual([
      { resource: "review_thread", action: "updated", id: "T1" },
      { resource: "check", action: "updated", id: "7" },
    ])
  })
})
