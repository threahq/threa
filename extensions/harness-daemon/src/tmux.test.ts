import { describe, expect, test } from "bun:test"
import { agentWindowExists } from "./tmux"
import type { ManagedAgent } from "./types"

function makeAgent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: "claude-1",
    name: "fix-failing-tests",
    runtime: "claude",
    status: "online",
    command: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    tmuxSession: "threa-agents",
    tmuxWindowId: "@169",
    ...overrides,
  }
}

/** Stubs `output` for the two shapes agentWindowExists asks for: the id lookup and the name scan. */
function fakeTmux(params: { byId?: string; names?: string[] }) {
  return ((command: string[]) => {
    if (command[1] === "display-message") {
      return params.byId !== undefined
        ? { exitCode: 0, stdout: params.byId, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "can't find window" }
    }
    return { exitCode: 0, stdout: (params.names ?? []).join("\n"), stderr: "" }
  }) as never
}

describe("agentWindowExists", () => {
  test("a recycled window id belonging to a different window is not this agent", () => {
    // tmux restarts window numbering at @0 on a new server, so @169 routinely
    // resolves to someone else's window — and the name scan finds nothing.
    const exists = agentWindowExists(
      makeAgent(),
      fakeTmux({ byId: "threa-agents\tprogressive-tools-discovery", names: ["progressive-tools-discovery"] })
    )
    expect(exists).toBe(false)
  })

  test("the recorded id with the recorded name in the recorded session is this agent", () => {
    const exists = agentWindowExists(makeAgent(), fakeTmux({ byId: "threa-agents\tfix-failing-tests" }))
    expect(exists).toBe(true)
  })

  test("a dead id still matches by window name", () => {
    const exists = agentWindowExists(makeAgent(), fakeTmux({ names: ["other", "fix-failing-tests"] }))
    expect(exists).toBe(true)
  })

  test("the same name in another session is not this agent", () => {
    const exists = agentWindowExists(makeAgent(), fakeTmux({ byId: "other-session\tfix-failing-tests", names: [] }))
    expect(exists).toBe(false)
  })
})
