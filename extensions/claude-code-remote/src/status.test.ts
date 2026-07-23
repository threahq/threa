import { describe, expect, it } from "bun:test"
import type { RemoteSessionStatusSnapshot } from "@threa/remote-session"
import { formatClaudeStatusReport, type ClaudeChannelStatusContext } from "./status"
import type { TmuxPaneSnapshot } from "./tmux-control"

const remote: RemoteSessionStatusSnapshot = {
  stopped: false,
  linkGeneration: 1,
  linkState: "linked",
  rootStreamId: "stream_1",
  activeStreamId: "stream_1",
  socketConnected: true,
  inflightCount: 1,
  activeTurnStreamId: "stream_1",
}

const context: ClaudeChannelStatusContext = {
  channelStarted: true,
  instanceId: "cc-one",
  runtimeSessionId: "ccs-one",
  remote,
  quotaHolding: false,
  pendingPermissionCount: 0,
  activeDelegationCount: 0,
}

const pane: TmuxPaneSnapshot = {
  sessionName: "1",
  windowName: "feature",
  windowId: "@7",
  paneId: "%8",
  panePid: 33336,
  width: 180,
  height: 48,
  cwd: "/repo/threa.feature",
  branch: "feat/status",
  view: "Waiting for 1 workflow to finish.\n``` nested fence",
}

describe("formatClaudeStatusReport", () => {
  it("reports connectivity, work, local identity, and the current pane", () => {
    const report = formatClaudeStatusReport(context, pane)

    expect(report).toContain("Threa: **Connected via WebSocket**")
    expect(report).toContain("Work: **Working — 1 active invocation**")
    expect(report).toContain("Tmux: `1:feature` · pane `%8` · 180×48")
    expect(report).toContain("Branch: `feat/status`")
    expect(report).toContain("Waiting for 1 workflow to finish.")
    expect(report).toContain("    ``` nested fence")
  })

  it("surfaces degraded connectivity and blockers", () => {
    const report = formatClaudeStatusReport(
      {
        ...context,
        remote: { ...remote, socketConnected: false },
        quotaHolding: true,
        pendingPermissionCount: 1,
        activeDelegationCount: 2,
      },
      pane
    )

    expect(report).toContain("Threa: **WebSocket disconnected — HTTP fallback enabled**")
    expect(report).toContain("Work: **Waiting on provider quota**")
    expect(report).toContain("Pending permissions: 1")
    expect(report).toContain("Active delegations: 2")
  })
})
