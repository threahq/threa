import { describe, expect, spyOn, test } from "bun:test"
import type { CommandClaim } from "@threahq/harness-client"
import { CLAIM_RENEW_EVERY_MS, CLAIM_TTL_SECONDS, claimCommandReporter } from "./command-reporter"

const TARGET = { baseUrl: "https://threa.test", workspaceId: "ws_1", apiKey: "key" }
const CLAIM: CommandClaim = {
  runtime: "pi",
  workspaceId: "ws_1",
  invocationId: "binv_done",
  instanceId: "pi-sidebar",
  claimToken: "claim-secret",
}

interface Posted {
  path: string
  body: unknown
}

function fakePost(respond: (path: string) => Response = () => Response.json({ data: {} })) {
  const posted: Posted[] = []
  const post = async (_target: typeof TARGET, path: string, body: unknown) => {
    posted.push({ path, body })
    return respond(path)
  }
  return { posted, post }
}

describe("claimCommandReporter", () => {
  test("renews on creation, fences every report with the claim, and closes the command silently", async () => {
    const { posted, post } = fakePost()
    const reporter = claimCommandReporter(TARGET, CLAIM, post)
    try {
      await reporter.progress("Committing, pushing and removing the worktree")
      await reporter.complete()
    } finally {
      reporter.stop()
    }

    const fenced = { instanceId: "pi-sidebar", claimToken: "claim-secret" }
    expect(posted).toEqual([
      { path: "/bot-invocations/binv_done/renew", body: { ...fenced, claimTtlSeconds: CLAIM_TTL_SECONDS } },
      {
        path: "/bot-invocations/binv_done/progress",
        body: { ...fenced, step: "Committing, pushing and removing the worktree" },
      },
      { path: "/bot-invocations/binv_done/complete", body: { ...fenced, noResponse: true } },
    ])
  })

  test("keeps renewing while the wind-down runs and stops when told", async () => {
    const { posted, post } = fakePost()
    const setInterval = spyOn(globalThis, "setInterval")
    const clearInterval = spyOn(globalThis, "clearInterval")
    try {
      const reporter = claimCommandReporter(TARGET, CLAIM, post)
      const [renew, every] = setInterval.mock.calls[0] as [() => void, number]
      expect(every).toBe(CLAIM_RENEW_EVERY_MS)
      renew()
      reporter.stop()
      expect(clearInterval).toHaveBeenCalledWith(setInterval.mock.results[0]?.value)
    } finally {
      setInterval.mockRestore()
      clearInterval.mockRestore()
    }
    await Promise.resolve()
    expect(posted.map(({ path }) => path)).toEqual([
      "/bot-invocations/binv_done/renew",
      "/bot-invocations/binv_done/renew",
    ])
  })

  test("a failed close is the one report that throws; steps and failures only log", async () => {
    const { posted, post } = fakePost((path) =>
      path.endsWith("/renew") ? Response.json({ data: {} }) : new Response("claim lost", { status: 404 })
    )
    const error = spyOn(console, "error").mockImplementation(() => {})
    const reporter = claimCommandReporter(TARGET, CLAIM, post)
    let logged: unknown[] = []
    try {
      await reporter.progress("Ending the session link")
      await reporter.fail("x".repeat(1200))
      await expect(reporter.complete()).rejects.toThrow("/done finished but its command could not be closed")
      logged = error.mock.calls.map((call) => call[0])
    } finally {
      reporter.stop()
      error.mockRestore()
    }

    expect(posted.at(2)?.body).toEqual({
      instanceId: "pi-sidebar",
      claimToken: "claim-secret",
      errorMessage: "x".repeat(1000),
    })
    expect(logged).toEqual([
      'harnessd: could not report "Ending the session link": 404 claim lost',
      "harnessd: could not fail the /done command: 404 claim lost",
      "harnessd: could not close the /done command: 404 claim lost",
    ])
  })
})
