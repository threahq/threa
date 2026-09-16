import { describe, expect, test } from "bun:test"
import type { CommandClaim } from "@threahq/harness-client"
import { runAttachedSpawn, type AttachedSpawnDeps } from "./spawn-attached"
import type { SpawnOptions, SpawnResult } from "./types"

const ATTACH = { rootStreamId: "stream_root", anchorId: "msg_anchor" }

const BASE_OPTIONS: SpawnOptions = {
  runtime: "claude",
  name: "fix-sidebar",
  attach: ATTACH,
}

const CLAIMED: SpawnOptions = { ...BASE_OPTIONS, claimFile: "/tmp/claim.json" }

const CLAIM: CommandClaim = {
  runtime: "claude",
  workspaceId: "ws_1",
  invocationId: "binv_spawn",
  instanceId: "cc-desk",
  claimToken: "claim-secret",
}

const RESULT: SpawnResult = {
  worktree: "/repo/fix-sidebar",
  branch: "fix/sidebar",
  tmuxSession: "threa-agents",
  tmuxWindow: "fix-sidebar",
  tmuxWindowId: "@7",
  tmuxPaneId: "%9",
  instanceId: "cc-sidebar",
  runtimeSessionId: "ccs-sidebar",
  activeStreamId: "stream_thread",
  output: "",
}

const GREETING = [
  "You were just started as `fix-sidebar` and nobody has asked you for anything yet.",
  "You are working in `/repo/fix-sidebar` on branch `fix/sidebar` (tmux window `fix-sidebar`).",
  "Say hello in a sentence or two, name where you are, and ask what they want done. Do not start any work yet.",
  "Send it with the channel `reply` tool, passing this event's `invocation_id`. Text you write in the terminal never reaches the person who spawned you, and this request stays open until you reply.",
].join("\n\n")

interface Recorded {
  calls: string[]
}

function makeDeps(
  options: {
    spawnResult?: SpawnResult | Error
    briefResult?: undefined | Error
    readBriefResult?: string | Error
  } = {}
): { deps: AttachedSpawnDeps; recorded: Recorded } {
  const recorded: Recorded = { calls: [] }
  const deps: AttachedSpawnDeps = {
    readBrief: (path) => {
      recorded.calls.push(`readBrief:${path}`)
      if (options.readBriefResult instanceof Error) throw options.readBriefResult
      return options.readBriefResult ?? "please fix the sidebar"
    },
    spawn: async (spawnOptions) => {
      recorded.calls.push(`spawn:${spawnOptions.name}`)
      if (options.spawnResult instanceof Error) throw options.spawnResult
      return options.spawnResult ?? RESULT
    },
    brief: async (body) => {
      recorded.calls.push(`brief:${body.runtime}:${body.instanceId}:${body.runtimeSessionId}:${body.content}`)
      if (options.briefResult instanceof Error) throw options.briefResult
    },
    unlinkBrief: (path) => {
      recorded.calls.push(`unlinkBrief:${path}`)
    },
    readClaim: (path) => {
      recorded.calls.push(`readClaim:${path}`)
      return CLAIM
    },
    commandReporter: (claim) => {
      recorded.calls.push(`reporter:${claim.invocationId}`)
      return {
        progress: async (step) => {
          recorded.calls.push(`progress:${step}`)
        },
        complete: async () => {
          recorded.calls.push("complete")
        },
        fail: async (message) => {
          recorded.calls.push(`fail:${message}`)
        },
        stop: () => {
          recorded.calls.push("stop")
        },
      }
    },
    log: (message) => {
      recorded.calls.push(`log:${message}`)
    },
  }
  return { deps, recorded }
}

describe("runAttachedSpawn", () => {
  test("happy path: reports each stage into the /spawn command and closes it, posting nothing", async () => {
    const { deps, recorded } = makeDeps()

    const result = await runAttachedSpawn({ ...CLAIMED, briefFile: "/tmp/brief.md" }, deps)

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_spawn",
      "readBrief:/tmp/brief.md",
      "progress:Provisioning a worktree for `fix-sidebar`",
      "spawn:fix-sidebar",
      "progress:Briefing `fix-sidebar`",
      "brief:claude:cc-sidebar:ccs-sidebar:please fix the sidebar",
      "complete",
      "stop",
      "unlinkBrief:/tmp/brief.md",
    ])
    expect(result).toBe(RESULT)
  })

  test("a spawn failure fails the command and rethrows without briefing", async () => {
    const failure = new Error("worktree provisioning failed")
    const { deps, recorded } = makeDeps({ spawnResult: failure })

    await expect(runAttachedSpawn({ ...CLAIMED, briefFile: "/tmp/brief.md" }, deps)).rejects.toThrow(
      "worktree provisioning failed"
    )

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_spawn",
      "readBrief:/tmp/brief.md",
      "progress:Provisioning a worktree for `fix-sidebar`",
      "spawn:fix-sidebar",
      "fail:spawn of `fix-sidebar` failed: worktree provisioning failed",
      "stop",
      "unlinkBrief:/tmp/brief.md",
    ])
  })

  test("a brief failure fails the command naming the thread that was started", async () => {
    const failure = new Error("brief endpoint 500")
    const { deps, recorded } = makeDeps({ briefResult: failure })

    await expect(runAttachedSpawn({ ...CLAIMED, briefFile: "/tmp/brief.md" }, deps)).rejects.toThrow(
      "brief endpoint 500"
    )

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_spawn",
      "readBrief:/tmp/brief.md",
      "progress:Provisioning a worktree for `fix-sidebar`",
      "spawn:fix-sidebar",
      "progress:Briefing `fix-sidebar`",
      "brief:claude:cc-sidebar:ccs-sidebar:please fix the sidebar",
      "fail:`fix-sidebar` started in thread stream_thread but the brief was not delivered: brief endpoint 500",
      "stop",
      "unlinkBrief:/tmp/brief.md",
    ])
  })

  test("no brief file briefs the agent to greet the user, and reads or unlinks nothing", async () => {
    const { deps, recorded } = makeDeps()

    const result = await runAttachedSpawn(CLAIMED, deps)

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_spawn",
      "progress:Provisioning a worktree for `fix-sidebar`",
      "spawn:fix-sidebar",
      "progress:Briefing `fix-sidebar`",
      `brief:claude:cc-sidebar:ccs-sidebar:${GREETING}`,
      "complete",
      "stop",
    ])
    expect(result).toBe(RESULT)
  })

  test("a `spawn` typed at the terminal drives no command and reads no claim", async () => {
    const { deps, recorded } = makeDeps()

    await runAttachedSpawn(BASE_OPTIONS, deps)

    expect(recorded.calls).toEqual(["spawn:fix-sidebar", `brief:claude:cc-sidebar:ccs-sidebar:${GREETING}`])
  })

  test("a prompt-less spawn whose thread never materialised briefs nobody", async () => {
    const { activeStreamId: _activeStreamId, ...withoutThread } = RESULT
    const { deps, recorded } = makeDeps({ spawnResult: withoutThread })

    await runAttachedSpawn(CLAIMED, deps)

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_spawn",
      "progress:Provisioning a worktree for `fix-sidebar`",
      "spawn:fix-sidebar",
      "complete",
      "stop",
    ])
  })

  test("an unreadable brief file fails the command, removes the file, and dies before spawn runs", async () => {
    const failure = new Error("ENOENT: no such file")
    const { deps, recorded } = makeDeps({ readBriefResult: failure })

    await expect(runAttachedSpawn({ ...CLAIMED, briefFile: "/tmp/missing.md" }, deps)).rejects.toThrow(
      "ENOENT: no such file"
    )

    expect(recorded.calls).toEqual([
      "readClaim:/tmp/claim.json",
      "reporter:binv_spawn",
      "readBrief:/tmp/missing.md",
      "fail:spawn of `fix-sidebar` failed: ENOENT: no such file",
      "stop",
      "unlinkBrief:/tmp/missing.md",
    ])
  })

  test("a spawn result with no identity fails the command instead of dying silently", async () => {
    const { instanceId: _instanceId, ...withoutIdentity } = RESULT
    const { deps, recorded } = makeDeps({ spawnResult: withoutIdentity })

    await expect(runAttachedSpawn({ ...CLAIMED, briefFile: "/tmp/brief.md" }, deps)).rejects.toThrow(
      "spawned agent has no instanceId to brief"
    )

    expect(recorded.calls.at(-3)).toBe(
      "fail:`fix-sidebar` started in thread stream_thread but the brief was not delivered: spawned agent has no instanceId to brief"
    )
  })

  test("an empty or whitespace-only brief file fails the command before spawn runs", async () => {
    for (const [content, path] of [
      ["", "/tmp/empty.md"],
      ["   \n\t  ", "/tmp/blank.md"],
    ] as const) {
      const { deps, recorded } = makeDeps({ readBriefResult: content })

      await expect(runAttachedSpawn({ ...CLAIMED, briefFile: path }, deps)).rejects.toThrow(
        `--brief-file ${path} is empty`
      )

      expect(recorded.calls).toEqual([
        "readClaim:/tmp/claim.json",
        "reporter:binv_spawn",
        `readBrief:${path}`,
        `fail:spawn of \`fix-sidebar\` failed: --brief-file ${path} is empty`,
        "stop",
        `unlinkBrief:${path}`,
      ])
    }
  })
})
