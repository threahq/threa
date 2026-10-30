import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "bun"
import { startAppUpdateServer, type BuildInfo } from "./server"

let buildRoot: string
let server: Server
let serverUrl: string

beforeEach(() => {
  buildRoot = mkdtempSync(join(tmpdir(), "threa-app-update-server-test-"))
  const dist = join(buildRoot, "dist-A")
  mkdirSync(dist)
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>synthetic app shell</title>")

  const info: BuildInfo = {
    buildRoot,
    createdAt: new Date().toISOString(),
    generations: {
      A: { version: "A", buildId: "A-test", dist, entryAsset: "/assets/app.js" },
    },
  }
  server = startAppUpdateServer(info)
  serverUrl = `http://127.0.0.1:${server.port}`
})

afterEach(() => {
  server.stop(true)
  rmSync(buildRoot, { recursive: true, force: true })
})

test("should reject non-object control request bodies", async () => {
  for (const body of [null, [], 1, "invalid"]) {
    const response = await fetch(`${serverUrl}/__control/deployed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 400,
      body: { error: "invalid_control_body" },
    })
  }
})

test("should return 404 for missing assets and shell only for extensionless navigation", async () => {
  const asset = await fetch(`${serverUrl}/assets/missing.js`)
  expect({ status: asset.status, cacheControl: asset.headers.get("cache-control") }).toEqual({
    status: 404,
    cacheControl: "no-store",
  })

  const navigation = await fetch(`${serverUrl}/some/app/route`)
  expect({
    status: navigation.status,
    contentType: navigation.headers.get("content-type"),
    body: await navigation.text(),
  }).toEqual({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>synthetic app shell</title>",
  })
})

test("should isolate mutable controls while sharing builds and close both servers", async () => {
  const dist = join(buildRoot, "dist-A")
  writeFileSync(join(dist, "sw.js"), "synthetic worker")
  const second = startAppUpdateServer({
    buildRoot,
    createdAt: new Date().toISOString(),
    generations: {
      A: { version: "A", buildId: "A-test", dist, entryAsset: "/assets/app.js" },
      B: { version: "B", buildId: "B-test", dist, entryAsset: "/assets/app.js" },
    },
  })
  const secondUrl = `http://127.0.0.1:${second.port}`
  const post = (origin: string, command: string, body = {}) =>
    fetch(`${origin}/__control/${command}`, { method: "POST", body: JSON.stringify(body) })

  try {
    const secondShell = await (await fetch(`${secondUrl}/`)).text()
    const firstShell = await (await fetch(`${serverUrl}/`)).text()

    expect(secondShell).toBe(firstShell)

    await post(secondUrl, "deployed", { version: "B" })
    await post(secondUrl, "latest", { version: "B" })
    await post(secondUrl, "fail-worker", { fail: true })
    await post(secondUrl, "fail-asset", { path: "/index.html" })
    await post(secondUrl, "corrupt-asset", { path: "/sw.js" })
    await post(serverUrl, "reset")

    const states = await Promise.all(
      [serverUrl, secondUrl].map(async (origin) => {
        const response = await fetch(`${origin}/__control/state`)
        const { deployed, latest, failWorker, failAssets, corruptAssets } = await response.json()

        return { deployed, latest, failWorker, failAssets, corruptAssets }
      })
    )

    expect(states).toEqual([
      { deployed: "A", latest: "A", failWorker: false, failAssets: [], corruptAssets: [] },
      { deployed: "B", latest: "B", failWorker: true, failAssets: ["/index.html"], corruptAssets: ["/sw.js"] },
    ])
    expect(
      await Promise.all([serverUrl, secondUrl].map(async (origin) => (await fetch(`${origin}/sw.js`)).status))
    ).toEqual([200, 503])

    await post(secondUrl, "reset")
    expect(await (await fetch(`${secondUrl}/sw.js`)).text()).toBe("synthetic worker")
  } finally {
    server.stop(true)
    second.stop(true)
  }

  for (const origin of [serverUrl, secondUrl]) {
    await expect(fetch(`${origin}/__ready`)).rejects.toThrow()
  }
  expect(await Bun.file(join(dist, "index.html")).text()).toBe("<!doctype html><title>synthetic app shell</title>")
})
