import { describe, expect, test } from "bun:test"
import { runAttachedSpawn, type AttachedSpawnDeps } from "./spawn-attached"
import type { SpawnOptions, SpawnResult } from "./types"

const ATTACH = { rootStreamId: "stream_root", anchorId: "msg_anchor" }

const BASE_OPTIONS: SpawnOptions = {
  runtime: "claude",
  name: "fix-sidebar",
  attach: ATTACH,
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

interface Recorded {
  calls: string[]
}

function makeDeps(
  options: {
    spawnResult?: SpawnResult | Error
    briefResult?: undefined | Error
    postToRootResult?: undefined | Error
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
      recorded.calls.push(`brief:${body.instanceId}:${body.runtimeSessionId}:${body.content}`)
      if (options.briefResult instanceof Error) throw options.briefResult
    },
    unlinkBrief: (path) => {
      recorded.calls.push(`unlinkBrief:${path}`)
    },
    postToRoot: async (rootStreamId, content) => {
      recorded.calls.push(`postToRoot:${rootStreamId}:${content}`)
      if (options.postToRootResult instanceof Error) throw options.postToRootResult
    },
    log: (message) => {
      recorded.calls.push(`log:${message}`)
    },
  }
  return { deps, recorded }
}

describe("runAttachedSpawn", () => {
  test("happy path: reads the brief, spawns, delivers the brief, then removes the file", async () => {
    const { deps, recorded } = makeDeps()

    const result = await runAttachedSpawn({ ...BASE_OPTIONS, briefFile: "/tmp/brief.md" }, deps)

    expect(recorded.calls).toEqual([
      "readBrief:/tmp/brief.md",
      "spawn:fix-sidebar",
      "brief:cc-sidebar:ccs-sidebar:please fix the sidebar",
      "unlinkBrief:/tmp/brief.md",
    ])
    expect(result).toBe(RESULT)
  })

  test("a spawn failure posts the failure to the root stream and rethrows without briefing", async () => {
    const failure = new Error("worktree provisioning failed")
    const { deps, recorded } = makeDeps({ spawnResult: failure })

    await expect(runAttachedSpawn({ ...BASE_OPTIONS, briefFile: "/tmp/brief.md" }, deps)).rejects.toThrow(
      "worktree provisioning failed"
    )

    expect(recorded.calls).toEqual([
      "readBrief:/tmp/brief.md",
      "spawn:fix-sidebar",
      "postToRoot:stream_root:harnessd: spawn of `fix-sidebar` failed: worktree provisioning failed",
      "unlinkBrief:/tmp/brief.md",
    ])
  })

  test("a brief failure posts the started-but-not-briefed message naming the thread and rethrows", async () => {
    const failure = new Error("brief endpoint 500")
    const { deps, recorded } = makeDeps({ briefResult: failure })

    await expect(runAttachedSpawn({ ...BASE_OPTIONS, briefFile: "/tmp/brief.md" }, deps)).rejects.toThrow(
      "brief endpoint 500"
    )

    expect(recorded.calls).toEqual([
      "readBrief:/tmp/brief.md",
      "spawn:fix-sidebar",
      "brief:cc-sidebar:ccs-sidebar:please fix the sidebar",
      "postToRoot:stream_root:harnessd: `fix-sidebar` started in thread stream_thread but the brief was not delivered: brief endpoint 500",
      "unlinkBrief:/tmp/brief.md",
    ])
  })

  test("no brief file means no readBrief, brief, or unlinkBrief calls", async () => {
    const { deps, recorded } = makeDeps()

    const result = await runAttachedSpawn(BASE_OPTIONS, deps)

    expect(recorded.calls).toEqual(["spawn:fix-sidebar"])
    expect(result).toBe(RESULT)
  })

  test("an unreadable brief file reports, removes the file, and dies before spawn runs", async () => {
    const failure = new Error("ENOENT: no such file")
    const { deps, recorded } = makeDeps({ readBriefResult: failure })

    await expect(runAttachedSpawn({ ...BASE_OPTIONS, briefFile: "/tmp/missing.md" }, deps)).rejects.toThrow(
      "ENOENT: no such file"
    )

    expect(recorded.calls).toEqual([
      "readBrief:/tmp/missing.md",
      "postToRoot:stream_root:harnessd: spawn of `fix-sidebar` failed: ENOENT: no such file",
      "unlinkBrief:/tmp/missing.md",
    ])
  })

  test("a spawn result with no identity reports the undelivered brief instead of dying silently", async () => {
    const { instanceId: _instanceId, ...withoutIdentity } = RESULT
    const { deps, recorded } = makeDeps({ spawnResult: withoutIdentity })

    await expect(runAttachedSpawn({ ...BASE_OPTIONS, briefFile: "/tmp/brief.md" }, deps)).rejects.toThrow(
      "spawned agent has no instanceId to brief"
    )

    expect(recorded.calls).toEqual([
      "readBrief:/tmp/brief.md",
      "spawn:fix-sidebar",
      "postToRoot:stream_root:harnessd: `fix-sidebar` started in thread stream_thread but the brief was not delivered: spawned agent has no instanceId to brief",
      "unlinkBrief:/tmp/brief.md",
    ])
  })

  test("an empty brief file reports, removes the file, and dies before spawn runs", async () => {
    const { deps, recorded } = makeDeps({ readBriefResult: "" })

    await expect(runAttachedSpawn({ ...BASE_OPTIONS, briefFile: "/tmp/empty.md" }, deps)).rejects.toThrow(
      "--brief-file /tmp/empty.md is empty"
    )

    expect(recorded.calls).toEqual([
      "readBrief:/tmp/empty.md",
      "postToRoot:stream_root:harnessd: spawn of `fix-sidebar` failed: --brief-file /tmp/empty.md is empty",
      "unlinkBrief:/tmp/empty.md",
    ])
  })

  test("a whitespace-only brief file reports, removes the file, and dies before spawn runs", async () => {
    const { deps, recorded } = makeDeps({ readBriefResult: "   \n\t  " })

    await expect(runAttachedSpawn({ ...BASE_OPTIONS, briefFile: "/tmp/blank.md" }, deps)).rejects.toThrow(
      "--brief-file /tmp/blank.md is empty"
    )

    expect(recorded.calls).toEqual([
      "readBrief:/tmp/blank.md",
      "postToRoot:stream_root:harnessd: spawn of `fix-sidebar` failed: --brief-file /tmp/blank.md is empty",
      "unlinkBrief:/tmp/blank.md",
    ])
  })

  test("a failure to post to the root is only logged, and the original error still rethrows", async () => {
    const spawnFailure = new Error("worktree provisioning failed")
    const postFailure = new Error("network down")
    const { deps, recorded } = makeDeps({ spawnResult: spawnFailure, postToRootResult: postFailure })

    await expect(runAttachedSpawn({ ...BASE_OPTIONS, briefFile: "/tmp/brief.md" }, deps)).rejects.toThrow(
      "worktree provisioning failed"
    )

    expect(recorded.calls).toEqual([
      "readBrief:/tmp/brief.md",
      "spawn:fix-sidebar",
      "postToRoot:stream_root:harnessd: spawn of `fix-sidebar` failed: worktree provisioning failed",
      "log:harnessd: could not post to root stream stream_root: network down",
      "unlinkBrief:/tmp/brief.md",
    ])
  })
})
