import { describe, expect, test } from "bun:test"
import { deriveGithubTargetUrls } from "./derive"

describe("deriveGithubTargetUrls", () => {
  test("pull_request → canonical PR URL from repo full name + pull_request.number", () => {
    expect(
      deriveGithubTargetUrls({
        eventType: "pull_request",
        repositoryFullName: "acme/widgets",
        payload: { action: "synchronize", pull_request: { number: 42 } },
      })
    ).toEqual(["https://github.com/acme/widgets/pull/42"])
  })

  test("pull_request_review → same PR URL (the reviewed PR)", () => {
    expect(
      deriveGithubTargetUrls({
        eventType: "pull_request_review",
        repositoryFullName: "acme/widgets",
        payload: { action: "submitted", pull_request: { number: 42 }, review: { state: "approved" } },
      })
    ).toEqual(["https://github.com/acme/widgets/pull/42"])
  })

  test("issues → canonical issue URL from issue.number", () => {
    expect(
      deriveGithubTargetUrls({
        eventType: "issues",
        repositoryFullName: "acme/widgets",
        payload: { action: "closed", issue: { number: 7 } },
      })
    ).toEqual(["https://github.com/acme/widgets/issues/7"])
  })

  test("falls back to top-level number when the nested object lacks one", () => {
    expect(
      deriveGithubTargetUrls({
        eventType: "pull_request",
        repositoryFullName: "acme/widgets",
        payload: { action: "opened", number: 99 },
      })
    ).toEqual(["https://github.com/acme/widgets/pull/99"])
  })

  test("returns [] when repository full name is missing", () => {
    expect(
      deriveGithubTargetUrls({
        eventType: "pull_request",
        repositoryFullName: null,
        payload: { pull_request: { number: 1 } },
      })
    ).toEqual([])
  })

  test("returns [] when repository full name is not owner/repo shaped", () => {
    expect(
      deriveGithubTargetUrls({
        eventType: "issues",
        repositoryFullName: "not a repo",
        payload: { issue: { number: 1 } },
      })
    ).toEqual([])
  })

  test("returns [] when no number can be found", () => {
    expect(
      deriveGithubTargetUrls({ eventType: "issues", repositoryFullName: "acme/widgets", payload: { action: "opened" } })
    ).toEqual([])
  })

  test("returns [] for a non-derivable event type", () => {
    expect(
      deriveGithubTargetUrls({ eventType: "installation", repositoryFullName: "acme/widgets", payload: {} })
    ).toEqual([])
  })
})
