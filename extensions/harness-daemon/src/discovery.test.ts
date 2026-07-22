import { describe, expect, test } from "bun:test"
import { deriveClaudeRuntimeIdentity } from "./spawners"
import {
  findLocalClaudeChannelPane,
  listLocalTmuxPanes,
  parseClaudeChannelLaunch,
  parseTmuxPanes,
  type LocalTmuxPane,
} from "./discovery"

function pane(overrides: Partial<LocalTmuxPane> = {}): LocalTmuxPane {
  return {
    sessionName: "1",
    windowName: "feature",
    windowId: "@7",
    paneId: "%8",
    panePid: 33336,
    cwd: "/Users/me/dev/threa.feature",
    startCommand:
      '"/Users/me/.local/bin/claude --name threa.feature --dangerously-load-development-channels server:threa-channel --dangerously-skip-permissions "',
    ...overrides,
  }
}

describe("parseTmuxPanes", () => {
  test("keeps live panes and their start command", () => {
    const input = [
      '0\t1\tfeature\t@7\t%8\t33336\t/Users/me/dev/threa.feature\t"claude --dangerously-load-development-channels server:threa-channel"',
      "1\t1\tdead\t@9\t%10\t99\t/tmp\tclaude",
      "",
    ].join("\n")

    expect(parseTmuxPanes(input)).toEqual([
      {
        sessionName: "1",
        windowName: "feature",
        windowId: "@7",
        paneId: "%8",
        panePid: 33336,
        cwd: "/Users/me/dev/threa.feature",
        startCommand: '"claude --dangerously-load-development-channels server:threa-channel"',
      },
    ])
  })
})

test("tmux inspection failures stay distinguishable from no matching pane", () => {
  expect(() => listLocalTmuxPanes(() => ({ stdout: "", stderr: "no server running", exitCode: 1 }))).toThrow(
    "could not inspect local tmux panes: no server running"
  )
})

describe("parseClaudeChannelLaunch", () => {
  test("accepts direct and env-prefixed Claude channel launch forms", () => {
    expect(
      parseClaudeChannelLaunch(
        '"/Users/me/.local/bin/claude --name threa.feature --dangerously-load-development-channels server:threa-channel "'
      )
    ).toEqual({ runtimeSessionId: undefined })
    expect(
      parseClaudeChannelLaunch(
        "env 'THREA_RUNTIME_SESSION_ID=ccs.explicit' /opt/bin/claude --dangerously-load-development-channels=server:threa-channel"
      )
    ).toEqual({ runtimeSessionId: "ccs-explicit" })
  })

  test("rejects commands that only contain Claude channel tokens", () => {
    for (const command of [
      "echo claude --dangerously-load-development-channels server:threa-channel",
      "bash -c 'claude --dangerously-load-development-channels server:threa-channel'",
      "python claude --dangerously-load-development-channels server:threa-channel",
      "pi --session-id ccs-target --dangerously-load-development-channels server:threa-channel",
    ]) {
      expect(parseClaudeChannelLaunch(command)).toBeUndefined()
    }
  })
})

describe("findLocalClaudeChannelPane", () => {
  test("matches a standalone helper launch by its cwd-derived runtime session id", () => {
    const candidate = pane()

    expect(deriveClaudeRuntimeIdentity(candidate.cwd, {}, "host-a").runtimeSessionId).toBe("ccs-4dca54f22ee90414")
    expect(findLocalClaudeChannelPane("ccs-4dca54f22ee90414", [candidate], {}, "host-a")).toEqual(candidate)
  })

  test("prefers and normalizes the runtime session id explicitly recorded in the launch command", () => {
    const candidate = pane({
      startCommand:
        '"env THREA_INSTANCE_ID=cc-one THREA_RUNTIME_SESSION_ID=ccs.explicit claude --dangerously-load-development-channels server:threa-channel"',
    })

    expect(findLocalClaudeChannelPane("ccs-explicit", [candidate], {}, "other-host")).toEqual(candidate)
  })

  test("rejects non-channel, renamed legacy-channel, and non-Claude panes", () => {
    const candidates = [
      pane({ startCommand: '"claude --dangerously-skip-permissions"' }),
      pane({ startCommand: '"claude --dangerously-load-development-channels server:threa"' }),
      pane({ startCommand: '"echo claude --dangerously-load-development-channels server:threa-channel"' }),
      pane({
        startCommand: '"pi --session-id ccs-target --dangerously-load-development-channels server:threa-channel"',
      }),
    ]

    expect(
      findLocalClaudeChannelPane("ccs-target", candidates, { runtimeSessionId: "ccs-target" }, "host-a")
    ).toBeUndefined()
  })

  test("refuses an ambiguous runtime identity", () => {
    expect(() =>
      findLocalClaudeChannelPane(
        "ccs-shared",
        [pane(), pane({ paneId: "%9", panePid: 44444, cwd: "/Users/me/dev/threa.other" })],
        { runtimeSessionId: "ccs-shared" },
        "host-a"
      )
    ).toThrow("multiple live unmanaged Claude channel panes match ccs-shared: %8, %9")
  })
})
