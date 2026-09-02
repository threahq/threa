import { describe, expect, test } from "bun:test"
import type { LocalTmuxPane } from "./discovery"
import {
  createBriefQueue,
  createOomKillWatch,
  formatOomNotice,
  formatOomRevivalBrief,
  formatOomSteer,
  matchOomKills,
  panePidOfScope,
  parseOomKills,
  readRecentOomKills,
  scopeOfPid,
  typeBrief,
  type BriefQueueDeps,
  type OomKill,
} from "./oom"
import type { ManagedAgent } from "./types"

const SCOPE = "tmux-spawn-fc2d9685-263d-4991-94e0-e468ce848ebd.scope"
const MEMCG = `/user.slice/user-1000.slice/user@1000.service/app.slice/${SCOPE}`

function journalLine(fields: Record<string, string>): string {
  return JSON.stringify({ __CURSOR: "s=1;i=1", __REALTIME_TIMESTAMP: "1788322219621162", ...fields })
}

const GLOBAL_KILL = [
  journalLine({
    __CURSOR: "s=1;i=223fa",
    MESSAGE: `oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=docker-26e9.scope,mems_allowed=0,global_oom,task_memcg=${MEMCG},task=bun,pid=834669,uid=1000`,
  }),
  journalLine({
    __CURSOR: "s=1;i=223fb",
    MESSAGE:
      "Out of memory: Killed process 834669 (bun) total-vm:90328000kB, anon-rss:11178380kB, file-rss:3040kB, shmem-rss:0kB, UID:1000 pgtables:24588kB oom_score_adj:200",
  }),
].join("\n")

function kill(overrides: Partial<OomKill> = {}): OomKill {
  return {
    cursor: "s=1;i=223fa",
    at: new Date(1788322219621),
    scope: SCOPE,
    pid: 834669,
    comm: "bun",
    anonRssKb: 11178380,
    ...overrides,
  }
}

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: "agent-1",
    name: "ariadne-subagents",
    runtime: "claude",
    status: "online",
    worktree: "/tmp/worktrees/ariadne",
    tmuxPaneId: "%39",
    scratchpadUrl: "https://app.threa.io/w/ws_1/s/stream_01ABCDEF",
    command: [],
    createdAt: "2026-09-02T04:05:00.000Z",
    updatedAt: "2026-09-02T04:05:00.000Z",
    ...overrides,
  }
}

function pane(overrides: Partial<LocalTmuxPane> = {}): LocalTmuxPane {
  return {
    sessionName: "0",
    windowName: "ariadne-subagents",
    windowId: "@24",
    paneId: "%39",
    panePid: 826815,
    cwd: "/tmp/worktrees/ariadne",
    startCommand: "claude",
    ...overrides,
  }
}

describe("parseOomKills", () => {
  test("should pair a global kill with its victim's resident size", () => {
    expect(parseOomKills(GLOBAL_KILL)).toEqual([kill()])
  })

  test("should read a per-cgroup kill the same way", () => {
    const lines = [
      journalLine({
        MESSAGE: `oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=${MEMCG},task_memcg=${MEMCG},task=bun,pid=99,uid=1000`,
      }),
      journalLine({
        MESSAGE:
          "Memory cgroup out of memory: Killed process 99 (bun) total-vm:100kB, anon-rss:6291456kB, file-rss:0kB, shmem-rss:0kB, UID:1000 pgtables:1kB oom_score_adj:200",
      }),
    ].join("\n")
    expect(parseOomKills(lines)).toEqual([kill({ cursor: "s=1;i=1", pid: 99, anonRssKb: 6291456 })])
  })

  test("should keep a kill whose Killed line is missing and skip lines that are not JSON", () => {
    const [oom] = GLOBAL_KILL.split("\n")
    expect(parseOomKills(`not json\n${oom}\n`)).toEqual([kill({ anonRssKb: undefined })])
  })
})

describe("readRecentOomKills", () => {
  test("should treat journalctl's no-match exit as no kills and a stderr as a failure", () => {
    expect(readRecentOomKills(180, () => ({ stdout: "", stderr: "", exitCode: 1 }))).toEqual([])
    expect(() => readRecentOomKills(180, () => ({ stdout: "", stderr: "boom", exitCode: 1 }))).toThrow(
      "journalctl -k failed: boom"
    )
    const commands: string[][] = []
    readRecentOomKills(180, (command) => {
      commands.push(command)
      return { stdout: GLOBAL_KILL, stderr: "", exitCode: 0 }
    })
    expect(commands).toEqual([
      ["journalctl", "-k", "-o", "json", "--no-pager", "--since", "-180s", "-g", "oom-kill:|Killed process"],
    ])
  })
})

describe("createOomKillWatch", () => {
  test("should baseline the window on the first call, then return each new kill once until it ages out", () => {
    let now = 1_000_000
    let kills = [kill()]
    const watch = createOomKillWatch({ read: () => kills, windowMs: 180_000, now: () => now })
    expect(watch.next()).toEqual([])
    expect(watch.next()).toEqual([])
    kills = [kill(), kill({ cursor: "s=1;i=300" })]
    expect(watch.next()).toEqual([kill({ cursor: "s=1;i=300" })])
    expect(watch.next()).toEqual([])
    now += 400_000
    expect(watch.next()).toEqual(kills)
  })
})

describe("scopeOfPid and panePidOfScope", () => {
  test("should read a live pid's scope from its cgroup and a dead scope's pane pid from the journal", () => {
    expect(scopeOfPid(1, () => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${SCOPE}\n`)).toBe(SCOPE)
    expect(
      scopeOfPid(1, () => {
        throw new Error("ENOENT")
      })
    ).toBeUndefined()
    expect(
      panePidOfScope(SCOPE, () => ({
        stdout: `Started ${SCOPE} - tmux child pane 826815 launched by process 1592.\n`,
        stderr: "",
        exitCode: 0,
      }))
    ).toBe(826815)
    expect(panePidOfScope(SCOPE, () => ({ stdout: "", stderr: "", exitCode: 1 }))).toBeUndefined()
  })
})

describe("matchOomKills", () => {
  test("should steer a live pane whose cgroup is the kill's scope", () => {
    const live = { agent: agent(), pane: pane() }
    expect(
      matchOomKills([kill()], {
        live: [live],
        vanished: [],
        scopeOfPid: (pid) => (pid === 826815 ? SCOPE : undefined),
        panePidOfScope: () => undefined,
      })
    ).toEqual({ live: [{ ...live, kill: kill() }], revive: [], unmatched: [] })
  })

  test("should brief the revival of a vanished pane whose last pid the journal recorded for the scope", () => {
    const gone = { agent: agent(), lastPane: pane() }
    expect(
      matchOomKills([kill()], {
        live: [{ agent: agent({ id: "other", tmuxPaneId: "%40" }), pane: pane({ paneId: "%40", panePid: 1 }) }],
        vanished: [gone],
        scopeOfPid: () => "tmux-spawn-other.scope",
        panePidOfScope: (scope) => (scope === SCOPE ? 826815 : undefined),
      })
    ).toEqual({ live: [], revive: [{ agent: gone.agent, kill: kill() }], unmatched: [] })
  })

  test("should leave a kill in an unmanaged pane unmatched", () => {
    expect(
      matchOomKills([kill()], {
        live: [],
        vanished: [{ agent: agent() }],
        scopeOfPid: () => undefined,
        panePidOfScope: () => 826815,
      })
    ).toEqual({ live: [], revive: [], unmatched: [kill()] })
  })
})

describe("typeBrief", () => {
  const deps = (text: string) => {
    const typed: string[] = []
    const logged: string[] = []
    return {
      typed,
      logged,
      deps: {
        capture: () => text,
        classify: (captured: string) =>
          captured.includes("Enter to confirm")
            ? ("safe-dialog" as const)
            : captured.includes("❯ ")
              ? ("idle" as const)
              : ("working" as const),
        type: (_paneId: string, line: string) => {
          typed.push(line)
          return true
        },
        log: (message: string) => void logged.push(message),
      },
    }
  }

  test("should refuse a Claude pane parked at a dialog and log why", () => {
    const dialog = deps("Press Enter to confirm")
    expect(typeBrief({ agent: agent(), paneId: "%39", text: "[OOM] …", allow: "idle-or-working" }, dialog.deps)).toBe(
      false
    )
    expect({ typed: dialog.typed, logged: dialog.logged }).toEqual({
      typed: [],
      logged: ["harnessd: ariadne-subagents is not at an idle composer (safe-dialog); the brief stays pending"],
    })
  })

  test("should type into a running turn only when the caller allows it", () => {
    const running = deps("● Running tests…")
    expect(typeBrief({ agent: agent(), paneId: "%39", text: "steer", allow: "idle-or-working" }, running.deps)).toBe(
      true
    )
    expect(running.typed).toEqual(["steer"])
    const booting = deps("● Running tests…")
    expect(typeBrief({ agent: agent(), paneId: "%39", text: "brief", allow: "idle" }, booting.deps)).toBe(false)
    const idle = deps("❯ ")
    expect(typeBrief({ agent: agent(), paneId: "%39", text: "brief", allow: "idle" }, idle.deps)).toBe(true)
  })

  test("should report a pane that refused the keys instead of claiming delivery", () => {
    const gone = deps("❯ ")
    gone.deps.type = () => false
    expect(typeBrief({ agent: agent(), paneId: "%39", text: "brief", allow: "idle" }, gone.deps)).toBe(false)
    expect(gone.logged).toEqual(["harnessd: ariadne-subagents's pane %39 refused the keys; the brief stays pending"])
  })

  test("should type into a Pi pane without classifying it", () => {
    const piPane = deps("Press Enter to confirm")
    expect(
      typeBrief({ agent: agent({ runtime: "pi" }), paneId: "%4", text: "brief", allow: "idle" }, piPane.deps)
    ).toBe(true)
    expect(piPane.typed).toEqual(["brief"])
  })
})

describe("createBriefQueue", () => {
  const revived = pane({ paneId: "%41", panePid: 999 })
  function queue(overrides: Partial<BriefQueueDeps> = {}) {
    const typed: Array<{ text: string; allow: string; paneId: string }> = []
    const notices: string[] = []
    const logged: string[] = []
    const q = createBriefQueue({
      type: ({ text, allow, paneId }) => {
        typed.push({ text, allow, paneId })
        return true
      },
      notify: async (_agent, content) => void notices.push(content),
      log: (message) => void logged.push(message),
      dryRun: false,
      now: () => kill().at.getTime(),
      ...overrides,
    })
    return { q, typed, notices, logged }
  }

  test("should notify the scratchpad when a kill is matched and steer the survivor on the same pane once", async () => {
    const { q, typed, notices } = queue()
    await q.record({ live: [{ agent: agent(), pane: pane(), kill: kill() }], revive: [], unmatched: [] })
    expect(notices).toEqual([formatOomNotice(kill(), "survived")])
    await q.deliver([{ agent: agent(), pane: pane() }])
    await q.deliver([{ agent: agent(), pane: pane() }])
    expect({ typed: typed.map((t) => [t.paneId, t.allow, t.text.slice(0, 5)]), notices }).toEqual({
      typed: [["%39", "idle-or-working", "[OOM]"]],
      notices: [formatOomNotice(kill(), "survived")],
    })
  })

  test("should brief a revival on its new pane at an idle composer, retrying until it is taken", async () => {
    let idle = false
    const { q, typed, notices } = queue({
      type: ({ allow, paneId }) => {
        typed.push({ text: "", allow, paneId })
        return idle
      },
    })
    await q.record({ live: [], revive: [{ agent: agent(), kill: kill() }], unmatched: [] })
    await q.deliver([{ agent: agent(), pane: revived }])
    expect(notices).toEqual([formatOomNotice(kill(), "revived")])
    idle = true
    await q.deliver([{ agent: agent(), pane: revived }])
    await q.deliver([{ agent: agent(), pane: revived }])
    expect({ attempts: typed.map((t) => [t.paneId, t.allow]), notices }).toEqual({
      attempts: [
        ["%41", "idle"],
        ["%41", "idle"],
      ],
      notices: [formatOomNotice(kill(), "revived")],
    })
  })

  test("should never type or notify under dry run and keep the brief pending", async () => {
    const { q, typed, notices, logged } = queue({ dryRun: true })
    await q.record({ live: [{ agent: agent(), pane: pane(), kill: kill() }], revive: [], unmatched: [] })
    await q.deliver([{ agent: agent(), pane: pane() }])
    await q.deliver([{ agent: agent(), pane: pane() }])
    expect({ typed, notices, logged }).toEqual({
      typed: [],
      notices: [],
      logged: [
        "harnessd: would tell ariadne-subagents (survived) about the OOM kill",
        "harnessd: would tell ariadne-subagents (survived) about the OOM kill",
      ],
    })
  })

  test("should drop a brief nobody took after the TTL and log the unmatched kills", async () => {
    let now = kill().at.getTime()
    const { q, typed, logged } = queue({ ttlMs: 1_000, now: () => now })
    await q.record({
      live: [],
      revive: [{ agent: agent(), kill: kill() }],
      unmatched: [kill({ pid: 7, scope: "x.scope" })],
    })
    now += 5_000
    await q.record({ live: [], revive: [], unmatched: [] })
    await q.deliver([{ agent: agent(), pane: revived }])
    expect({ typed, logged }).toEqual({
      typed: [],
      logged: [
        "harnessd: OOM kill outside managed panes: bun pid 7 in x.scope",
        "harnessd: dropped an undelivered OOM brief for ariadne-subagents (bun pid 834669); no idle pane took it",
      ],
    })
  })
})

describe("OOM wording", () => {
  test("should name the victim, its size, and the exit code in every message", () => {
    const steer = formatOomSteer(kill())
    const brief = formatOomRevivalBrief(kill())
    for (const text of [steer, brief]) {
      expect(text).toContain("pid 834669 (bun, 10.7 GB resident)")
      expect(text).not.toContain("\n")
    }
    expect(steer).toContain("exit code 137")
    expect(brief).toContain("[OOM recovery]")
    expect(formatOomNotice(kill({ anonRssKb: undefined }), "survived")).toContain("`bun` (pid 834669)")
    expect(formatOomNotice(kill(), "revived")).toContain("is reviving it and will brief it")
  })
})
