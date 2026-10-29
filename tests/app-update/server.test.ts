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
