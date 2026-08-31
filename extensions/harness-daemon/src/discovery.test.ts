import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessLink } from "@threa/harness-client"
import type { MintedIdentity } from "./identity-store"
import { deriveClaudeRuntimeIdentity } from "./spawners"
import {
  findLocalClaudeChannelPane,
  listLocalTmuxPanes,
  parseClaudeChannelLaunch,
  parseTmuxPanes,
  resolveManagedAgentPane,
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

function link(overrides: Partial<HarnessLink> = {}): HarnessLink {
  return {
    runtimeKind: "claude-code-channel",
    runtimeSessionId: "ccs-real",
    instanceId: "cc-real",
    rootStreamId: "stream_real",
    worktree: "/Users/me/dev/threa.feature",
    pid: 33336,
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  }
}

const noLinks = () => []

function identity(overrides: Partial<MintedIdentity> = {}): MintedIdentity {
  return {
    runtimeSessionId: "ccs-minted",
    instanceId: "cc-minted",
    worktree: "/Users/me/dev/threa.feature",
    runtimeKind: "claude-code-channel",
    mintedAt: "2026-07-29T00:00:00.000Z",
    source: "mint",
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
    ).toEqual({
      runtimeSessionId: undefined,
      name: "threa.feature",
      mcpConfig: undefined,
      skipPermissions: false,
    })
    expect(
      parseClaudeChannelLaunch(
        "env 'THREA_RUNTIME_SESSION_ID=ccs.explicit' /opt/bin/claude --dangerously-load-development-channels=server:threa-channel"
      )
    ).toEqual({ runtimeSessionId: "ccs-explicit", name: undefined, mcpConfig: undefined, skipPermissions: false })
  })

  test("reports the bypass, name, and MCP wiring an adoption has to match", () => {
    expect(
      parseClaudeChannelLaunch(
        "env THREA_RUNTIME_SESSION_ID=ccs-slop claude --name slopenv --mcp-config /tmp/threa.json --dangerously-load-development-channels server:threa-channel --dangerously-skip-permissions"
      )
    ).toEqual({
      runtimeSessionId: "ccs-slop",
      name: "slopenv",
      mcpConfig: "/tmp/threa.json",
      skipPermissions: true,
    })
    expect(
      parseClaudeChannelLaunch("claude --name=slopenv --dangerously-load-development-channels=server:threa-channel")
    ).toMatchObject({ name: "slopenv", skipPermissions: false })
  })

  test("retains parent-compatible tmux parsing for single-quoted literal expansions", () => {
    expect(
      parseClaudeChannelLaunch(
        "\"env 'THREA_DISPLAY_NAME=price $5 `literal`' THREA_RUNTIME_SESSION_ID=ccs.parent claude --dangerously-load-development-channels server:threa-channel\""
      )
    ).toEqual({ runtimeSessionId: "ccs-parent", name: undefined, mcpConfig: undefined, skipPermissions: false })
  })

  test("rejects commands that only contain Claude channel tokens", () => {
    for (const command of [
      "echo claude --dangerously-load-development-channels server:threa-channel",
      "bash -c 'claude --dangerously-load-development-channels server:threa-channel'",
      "python claude --dangerously-load-development-channels server:threa-channel",
      "pi --session-id ccs-target --dangerously-load-development-channels server:threa-channel",
      "claude -- --dangerously-load-development-channels server:threa-channel",
    ]) {
      expect(parseClaudeChannelLaunch(command)).toBeUndefined()
    }
  })
})

describe("findLocalClaudeChannelPane", () => {
  test("matches a standalone helper launch by its cwd-derived runtime session id", () => {
    const candidate = pane()

    expect(deriveClaudeRuntimeIdentity(candidate.cwd, {}, "host-a").runtimeSessionId).toBe("ccs-4dca54f22ee90414")
    expect(findLocalClaudeChannelPane("ccs-4dca54f22ee90414", [candidate], {}, "host-a", noLinks)).toEqual(candidate)
  })

  test("prefers and normalizes the runtime session id explicitly recorded in the launch command", () => {
    const candidate = pane({
      startCommand:
        '"env THREA_INSTANCE_ID=cc-one THREA_RUNTIME_SESSION_ID=ccs.explicit claude --dangerously-load-development-channels server:threa-channel"',
    })

    expect(findLocalClaudeChannelPane("ccs-explicit", [candidate], {}, "other-host", noLinks)).toEqual(candidate)
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
      findLocalClaudeChannelPane("ccs-target", candidates, { runtimeSessionId: "ccs-target" }, "host-a", noLinks)
    ).toBeUndefined()
  })

  test("refuses an ambiguous runtime identity", () => {
    expect(() =>
      findLocalClaudeChannelPane(
        "ccs-shared",
        [pane(), pane({ paneId: "%9", panePid: 44444, cwd: "/Users/me/dev/threa.other" })],
        { runtimeSessionId: "ccs-shared" },
        "host-a",
        noLinks
      )
    ).toThrow("multiple live unmanaged Claude channel panes match ccs-shared: %8, %9")
  })
})

describe("resolveManagedAgentPane", () => {
  const host = "host-a"
  const config = {}
  const agent = { runtime: "claude" as const, worktree: "/Users/me/dev/threa.feature" }

  test("a recycled window id pointing at another worktree is not this agent", () => {
    // The recorded @7/%8 now belong to an unrelated agent: tmux restarts its
    // numbering at @0 on a new server, so the ids alone would say "running".
    const resolved = resolveManagedAgentPane(
      { ...agent, tmuxWindowId: "@7", tmuxPaneId: "%8" },
      [pane({ cwd: "/Users/me/dev/threa.somebody-else", windowName: "somebody-else" })],
      config,
      host
    )
    expect(resolved).toEqual({ status: "missing" })
  })

  test("resolves by runtime session identity, ignoring stale recorded ids", () => {
    const live = pane({ windowId: "@42", paneId: "%43" })
    const resolved = resolveManagedAgentPane(
      {
        ...agent,
        runtimeSessionId: deriveClaudeRuntimeIdentity(live.cwd, config, host).runtimeSessionId,
        tmuxWindowId: "@7",
        tmuxPaneId: "%8",
      },
      [pane({ cwd: "/Users/me/dev/threa.other", windowId: "@7", paneId: "%8" }), live],
      config,
      host,
      noLinks
    )
    expect(resolved).toEqual({ status: "found", pane: live })
  })

  test("falls back to the worktree when no runtime session is recorded", () => {
    const live = pane({ windowId: "@42", paneId: "%43" })
    const resolved = resolveManagedAgentPane({ ...agent, tmuxWindowId: "@7" }, [live], config, host)
    expect(resolved).toEqual({ status: "found", pane: live })
  })

  test("the worktree fallback ignores a coexisting runtime's pane", () => {
    // Without the filter a Pi sharing the cwd makes every legacy
    // worktree-keyed row ambiguous — or a lone Pi pane reads as "found".
    const piPane = pane({
      paneId: "%9",
      windowId: "@8",
      startCommand: "pi --session-id 095ed570-f6ce-4fd6-a33e-ac0d71c4625f",
    })
    expect(resolveManagedAgentPane(agent, [pane(), piPane], config, host)).toEqual({
      status: "found",
      pane: pane(),
    })
    expect(resolveManagedAgentPane(agent, [piPane], config, host)).toEqual({ status: "missing" })
    expect(
      resolveManagedAgentPane({ runtime: "pi", worktree: agent.worktree }, [pane(), piPane], config, host)
    ).toEqual({ status: "found", pane: piPane })
  })

  test("two panes in one worktree with no matching id is ambiguous, not a guess", () => {
    const resolved = resolveManagedAgentPane(
      { ...agent, tmuxPaneId: "%99" },
      [pane(), pane({ paneId: "%9", windowId: "@8" })],
      config,
      host
    )
    expect(resolved).toEqual({
      status: "ambiguous",
      reason: "2 panes share /Users/me/dev/threa.feature and none matches the recorded ids",
    })
  })

  test("a row with neither identity nor worktree resolves as unverified, never as found", () => {
    // %8 may be this agent's pane or a stranger's — tmux recycles the number,
    // and there is no second key to corroborate it with.
    const live = pane()
    expect(resolveManagedAgentPane({ runtime: "claude", tmuxPaneId: "%8" }, [live], config, host)).toEqual({
      status: "unverified",
      pane: live,
      reason: "only a recycled tmux id (%8) identifies this row — no runtime session or worktree recorded",
    })
    expect(resolveManagedAgentPane({ runtime: "claude", tmuxPaneId: "%404" }, [live], config, host)).toEqual({
      status: "missing",
    })
  })
})

describe("findLocalClaudeChannelPane ledger attestation", () => {
  test("a pane launched without THREA_ env is identified by its harness link record", () => {
    const candidate = pane()

    expect(deriveClaudeRuntimeIdentity(candidate.cwd, {}, "host-a").runtimeSessionId).not.toBe("ccs-real")
    expect(findLocalClaudeChannelPane("ccs-real", [candidate], {}, "host-a", () => [link()])).toEqual(candidate)
  })

  test("a declared runtime session id wins over the ledger", () => {
    const candidate = pane({
      startCommand:
        '"env THREA_RUNTIME_SESSION_ID=ccs-declared claude --dangerously-load-development-channels server:threa-channel"',
    })
    const links = () => [link({ runtimeSessionId: "ccs-other", worktree: candidate.cwd })]

    expect(findLocalClaudeChannelPane("ccs-declared", [candidate], {}, "host-a", links)).toEqual(candidate)
    expect(findLocalClaudeChannelPane("ccs-other", [candidate], {}, "host-a", links)).toBeUndefined()
  })

  test("falls back to the derived identity when no record names the cwd", () => {
    const candidate = pane()
    const links = () => [link({ worktree: "/Users/me/dev/threa.somebody-else" })]

    expect(findLocalClaudeChannelPane("ccs-real", [candidate], {}, "host-a", links)).toBeUndefined()
    expect(findLocalClaudeChannelPane("ccs-4dca54f22ee90414", [candidate], {}, "host-a", links)).toEqual(candidate)
  })

  test("two records naming one worktree fall through to derivation rather than guessing", () => {
    const candidate = pane()
    const links = () => [link(), link({ runtimeSessionId: "ccs-rival", instanceId: "cc-rival" })]

    expect(findLocalClaudeChannelPane("ccs-real", [candidate], {}, "host-a", links)).toBeUndefined()
    expect(findLocalClaudeChannelPane("ccs-rival", [candidate], {}, "host-a", links)).toBeUndefined()
    expect(findLocalClaudeChannelPane("ccs-4dca54f22ee90414", [candidate], {}, "host-a", links)).toEqual(candidate)
  })

  test("a pane launched without THREA_ environment resolves to its minted identity", () => {
    // The minted record is what the hostname derivation cannot reproduce, and
    // it outranks the ledger for the same directory.
    const candidate = pane()
    const identities = () => [identity()]

    expect(findLocalClaudeChannelPane("ccs-minted", [candidate], {}, "host-a", noLinks, identities)).toEqual(candidate)
    expect(
      findLocalClaudeChannelPane("ccs-real", [candidate], {}, "host-a", () => [link()], identities)
    ).toBeUndefined()
    expect(
      findLocalClaudeChannelPane("ccs-4dca54f22ee90414", [candidate], {}, "host-a", noLinks, identities)
    ).toBeUndefined()
  })

  test("a pi-local record never identifies a Claude pane", () => {
    const candidate = pane()
    const links = () => [link({ runtimeKind: "pi-local", runtimeSessionId: "ccs-pi" })]

    expect(findLocalClaudeChannelPane("ccs-pi", [candidate], {}, "host-a", links)).toBeUndefined()
    expect(findLocalClaudeChannelPane("ccs-4dca54f22ee90414", [candidate], {}, "host-a", links)).toEqual(candidate)
  })

  test("an un-canonicalized worktree in the record still matches the pane's real cwd", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "discovery-links-"))
    const real = join(root, "worktree")
    mkdirSync(real)
    const linked = join(root, "alias")
    symlinkSync(real, linked)

    const candidate = pane({ cwd: real })

    expect(
      findLocalClaudeChannelPane("ccs-real", [candidate], {}, "host-a", () => [link({ worktree: linked })])
    ).toEqual(candidate)
  })

  test("a symlinked pane cwd still matches the record's canonical worktree", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "discovery-panecwd-"))
    const real = join(root, "worktree")
    mkdirSync(real)
    const linked = join(root, "alias")
    symlinkSync(real, linked)

    const candidate = pane({ cwd: linked })

    expect(findLocalClaudeChannelPane("ccs-real", [candidate], {}, "host-a", () => [link({ worktree: real })])).toEqual(
      candidate
    )
  })
})
