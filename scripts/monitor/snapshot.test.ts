import { describe, expect, test } from "bun:test"
import type { ExecLike } from "./github"
import { takeSnapshot, type Deps, type Section } from "./snapshot"

const NOW = new Date("2026-08-21T18:00:00Z")
const SHA = "1ff063b5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const CREDS = {
  RAILWAY_READONLY_TOKEN: "rw",
  DB_READ_PROXY_URL: "https://proxy.test",
  DB_READ_PROXY_SECRET: "s",
  THREA_PROD_BASE_URL: "https://app.threa.io",
  THREA_PROD_READ_ONLY_API_KEY: "k",
  THREA_PROD_DEFAULT_WORKSPACE: "ws_1",
}

const deployment = (service: string, status = "SUCCESS", staticUrl: string | null = null) => ({
  id: `${service}-${status}`,
  status,
  createdAt: "2026-08-21T17:00:00.000Z",
  staticUrl,
  service: { name: service },
  meta: { commitHash: SHA, commitMessage: "feat" },
})

function railwayAnswer(query: string): unknown {
  if (query.includes("projectToken")) return { projectToken: { projectId: "p", environmentId: "e" } }
  if (query.includes("project(id"))
    return { project: { services: { edges: [{ node: { id: "svc-backend", name: "backend" } }] } } }
  if (query.includes("deployments(")) {
    return {
      deployments: {
        edges: [
          deployment("backend", "SUCCESS", "ws-eu.threa.io"),
          deployment("control-plane"),
          deployment("enclave"),
          deployment("db-read-proxy", "SUCCESS", "db-read-proxy-production.up.railway.app"),
        ].map((node) => ({ node })),
      },
    }
  }
  if (query.includes("environmentLogs")) return { environmentLogs: [] }
  if (query.includes("metrics(")) return { metrics: [] }
  throw new Error(`unexpected railway query: ${query.slice(0, 60)}`)
}

function proxyAnswer(sql: string): { columns: string[]; rows: unknown[][] } {
  if (sql.includes("FROM outbox_listeners"))
    return {
      columns: ["listener_id", "lag", "last_processed_at", "retry_count", "last_error"],
      rows: [["broadcast", "0", NOW.toISOString(), "0", null]],
    }
  if (sql.includes("COALESCE(max(id), 0) AS head")) return { columns: ["head"], rows: [["100"]] }
  if (sql.includes("FROM outbox_dead_letters")) return { columns: ["since", "prior"], rows: [["0", "0"]] }
  if (sql.includes("FROM queue_messages")) return { columns: ["queue_name"], rows: [] }
  if (sql.includes("FROM agent_sessions")) return { columns: ["metric", "since", "prior"], rows: [] }
  throw new Error(`unexpected sql: ${sql.slice(0, 60)}`)
}

interface Recorded {
  urls: string[]
  cmds: string[][]
}

function fakeDeps(
  over: { creds?: Partial<typeof CREDS>; versionFails?: boolean; ciConclusion?: string; creds0?: boolean } = {}
): { deps: Deps; seen: Recorded } {
  const seen: Recorded = { urls: [], cmds: [] }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    seen.urls.push(url)
    if (url.startsWith("https://backboard.railway.com")) {
      const { query } = JSON.parse(String(init?.body)) as { query: string }
      return json({ data: railwayAnswer(query) })
    }
    if (url.includes("/version.json")) {
      if (over.versionFails) throw new Error("version.json unreachable")
      return json({ version: SHA.slice(0, 7), builtAt: "2026-08-21T16:00:00Z" })
    }
    if (url.endsWith("/query")) {
      const { sql } = JSON.parse(String(init?.body)) as { sql: string }
      const answer = proxyAnswer(sql)
      return json({ ...answer, rowCount: answer.rows.length, truncated: false, durationMs: 1 })
    }
    return json({ ok: true })
  }) as unknown as typeof fetch
  const exec: ExecLike = async (cmd) => {
    seen.cmds.push(cmd)
    if (cmd[0] === "git") return { stdout: `${SHA}\trefs/heads/main\n`, stderr: "", exitCode: 0 }
    if (cmd[0] === "gh") {
      const runs = over.ciConclusion
        ? [
            {
              workflowName: "CI",
              status: "completed",
              conclusion: over.ciConclusion,
              headSha: SHA,
              createdAt: "2026-08-21T17:10:00Z",
              url: "https://gh/run/9",
              databaseId: 9,
            },
          ]
        : []
      return { stdout: JSON.stringify(runs), stderr: "", exitCode: 0 }
    }
    throw new Error(`unexpected exec ${cmd.join(" ")}`)
  }
  const creds = over.creds0 ? {} : { ...CREDS, ...over.creds }
  return { deps: { fetchImpl, exec, creds, now: () => NOW }, seen }
}

const sections = (...list: Section[]) => new Set<Section>(list)

describe("takeSnapshot", () => {
  test("a green deploy with every section is ok, windows off the backend deploy, and names the expected sha", async () => {
    const { deps, seen } = fakeDeps()
    const snapshot = await takeSnapshot(deps, {
      sections: sections("revision", "liveness", "pipelines", "logs", "resources"),
    })
    expect(snapshot).toMatchObject({
      at: NOW.toISOString(),
      expectedSha: SHA,
      level: "ok",
      findings: [],
      errors: [],
      window: { label: "since backend deploy 17:00Z (60m window)" },
    })
    expect(snapshot.revision?.planes.map((plane) => [plane.plane, plane.level])).toEqual([
      ["frontend", "ok"],
      ["backend", "ok"],
      ["control-plane", "ok"],
      ["enclave", "ok"],
      ["db-read-proxy", "ok"],
    ])
    expect(snapshot.liveness?.checks.map((check) => check.name)).toEqual([
      "frontend /",
      "router → control-plane /api/regions",
      "backend /health",
      "db-read-proxy /health",
      "public API /me (auth → router → backend → db)",
    ])
    expect(seen.cmds.map((cmd) => cmd.slice(0, 3).join(" "))).toEqual(["git ls-remote origin", "gh run list"])
  })

  test("excluding revision skips git/GitHub/version.json entirely and leaves expectedSha null", async () => {
    const { deps, seen } = fakeDeps()
    const snapshot = await takeSnapshot(deps, { since: "2026-08-21T17:30:00Z", sections: sections("logs") })
    expect(snapshot).toMatchObject({
      expectedSha: null,
      revision: null,
      liveness: null,
      pipelines: null,
      resources: null,
      level: "ok",
      errors: [],
    })
    expect(snapshot.logs?.window.label).toBe("since --since 17:30Z (30m window)")
    expect(seen.cmds).toEqual([])
    expect(seen.urls.some((url) => url.includes("version.json"))).toBe(false)
  })

  test("liveness without revision still lists Railway deployments for the health hosts", async () => {
    const { deps, seen } = fakeDeps()
    const snapshot = await takeSnapshot(deps, { since: "2026-08-21T17:30:00Z", sections: sections("liveness") })
    expect(snapshot.liveness?.checks.map((check) => check.name)).toContain("backend /health")
    expect(seen.cmds).toEqual([])
  })

  test("missing credentials skip their sections with a visible error each, and liveness still probes the public hosts", async () => {
    const { deps } = fakeDeps({ creds0: true })
    const snapshot = await takeSnapshot(deps, {
      sha: SHA,
      sections: sections("revision", "liveness", "pipelines", "logs", "resources"),
    })
    expect(snapshot.level).toBe("warn")
    expect(snapshot.errors).toEqual([
      { section: "railway", error: "RAILWAY_READONLY_TOKEN missing; Railway planes skipped" },
      { section: "pipelines", error: "DB_READ_PROXY_URL/SECRET missing; pipelines skipped" },
      { section: "logs", error: "RAILWAY_READONLY_TOKEN missing; logs skipped" },
      { section: "resources", error: "RAILWAY_READONLY_TOKEN missing; resources skipped" },
    ])
    expect(snapshot.revision?.planes.map((plane) => plane.level)).toEqual([
      "ok",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ])
    expect(snapshot.liveness?.checks.map((check) => check.name)).toEqual([
      "frontend /",
      "router → control-plane /api/regions",
    ])
    expect(snapshot.window.label).toBe("last 30m (no deploy time) 17:30Z (30m window)")
  })

  test("an unreachable version.json leaves the frontend plane pending instead of throwing", async () => {
    const { deps } = fakeDeps({ versionFails: true })
    const snapshot = await takeSnapshot(deps, { sha: SHA, sections: sections("revision") })
    expect(snapshot.revision?.planes[0]).toMatchObject({ plane: "frontend", live: null, level: "pending" })
    expect(snapshot.level).toBe("pending")
  })

  test("a failed CI run makes the snapshot fail and the finding carries the run url", async () => {
    const { deps } = fakeDeps({ versionFails: true, ciConclusion: "failure" })
    const snapshot = await takeSnapshot(deps, { sha: SHA, sections: sections("revision") })
    expect(snapshot.level).toBe("fail")
    expect(snapshot.findings).toEqual([
      {
        level: "fail",
        id: "revision.frontend",
        message: "frontend: serving unknown; CI failure, so Deploy Cloudflare will not run (https://gh/run/9)",
      },
    ])
  })
})

test("a failed Railway call leaves the Railway planes pending with the error, never a fabricated fail", async () => {
  const { deps } = fakeDeps()
  const failing = deps.fetchImpl
  deps.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://backboard.railway.com")) return new Response("upstream down", { status: 502 })
    return failing(input, init)
  }) as typeof fetch
  const snapshot = await takeSnapshot(deps, { sha: SHA, sections: sections("revision") })
  expect(snapshot.revision?.planes.slice(1).map((plane) => [plane.level, plane.detail])).toEqual(
    Array(4).fill(["pending", "Railway query failed, will retry: railway 502: upstream down"])
  )
  expect(snapshot.findings.map((finding) => finding.id)).toContain("error.railway")
  expect(snapshot.level).toBe("warn")
})
