import { readFileSync, existsSync, statSync, rmSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Server } from "bun"
import { z } from "../../apps/frontend/node_modules/zod/index.js"
import { writeServerPort } from "./support/port"

const __dirname = fileURLToPath(new URL(".", import.meta.url))

export interface BuildInfo {
  generations: Record<string, { version: string; buildId: string; dist: string; entryAsset: string }>
  buildRoot: string
}

const info: BuildInfo = JSON.parse(readFileSync(join(__dirname, ".build-info.json"), "utf-8"))

const controlBodySchema = z.record(z.string(), z.unknown())

const state = {
  deployed: "A" as string,
  latest: "A" as string,
  failWorker: false,
  failAssetPaths: new Set<string>(),
  corruptAssetPaths: new Set<string>(),
}

function generation() {
  const g = info.generations[state.deployed]
  if (!g) throw new Error(`unknown deployed generation: ${state.deployed}`)
  return g
}

function filePath(urlPath: string): string | null {
  const g = generation()
  if (urlPath === "/" || urlPath === "/index.html") return join(g.dist, "index.html")
  if (urlPath === "/sw.js") return join(g.dist, "sw.js")
  if (urlPath === "/version.json") return null // generated from state.latest

  const candidate = resolve(g.dist, `.${urlPath}`)
  if (candidate === g.dist || candidate.startsWith(g.dist + sep)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return urlPath.split("/").pop()?.includes(".") ? null : join(g.dist, "index.html")
}

function contentType(path: string): string {
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "application/javascript"
  if (path.endsWith(".css")) return "text/css"
  if (path.endsWith(".html")) return "text/html"
  if (path.endsWith(".json")) return "application/json"
  if (path.endsWith(".svg")) return "image/svg+xml"
  if (path.endsWith(".png")) return "image/png"
  if (path.endsWith(".webp")) return "image/webp"
  if (path.endsWith(".woff2")) return "font/woff2"
  return "application/octet-stream"
}

async function handleControl(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === "/__control/state" && req.method === "GET") {
    return Response.json({
      deployed: state.deployed,
      latest: state.latest,
      failWorker: state.failWorker,
      failAssets: [...state.failAssetPaths],
      corruptAssets: [...state.corruptAssetPaths],
      generations: Object.fromEntries(
        Object.entries(info.generations).map(([k, g]) => [
          k,
          {
            version: g.version,
            buildId: g.buildId,
            entryAsset: g.entryAsset,
          },
        ])
      ),
    })
  }

  if (req.method !== "POST") return new Response("method not allowed", { status: 405 })

  let input: unknown = {}
  try {
    const text = await req.text()
    if (text) input = JSON.parse(text)
  } catch {
    return Response.json({ error: "invalid_control_body" }, { status: 400 })
  }
  const parsed = controlBodySchema.safeParse(input)
  if (!parsed.success) return Response.json({ error: "invalid_control_body" }, { status: 400 })
  const body = parsed.data

  if (path === "/__control/deployed") {
    if (typeof body.version === "string") state.deployed = body.version
  } else if (path === "/__control/latest") {
    if (typeof body.version === "string") state.latest = body.version
  } else if (path === "/__control/fail-worker") {
    state.failWorker = body.fail === true
  } else if (path === "/__control/fail-asset") {
    if (typeof body.path === "string") state.failAssetPaths.add(body.path)
  } else if (path === "/__control/clear-fail-asset") {
    if (typeof body.path === "string") state.failAssetPaths.delete(body.path)
  } else if (path === "/__control/corrupt-asset") {
    if (typeof body.path === "string") state.corruptAssetPaths.add(body.path)
  } else if (path === "/__control/clear-corrupt-asset") {
    if (typeof body.path === "string") state.corruptAssetPaths.delete(body.path)
  } else if (path === "/__control/reset") {
    state.deployed = "A"
    state.latest = "A"
    state.failWorker = false
    state.failAssetPaths.clear()
    state.corruptAssetPaths.clear()
  } else {
    return new Response("unknown control command", { status: 404 })
  }

  return Response.json({ ok: true })
}

const port = process.env.APP_UPDATE_SERVER_PORT ? Number(process.env.APP_UPDATE_SERVER_PORT) : 0

const server: Server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url)
    const pathname = url.pathname

    if (pathname.startsWith("/__control/")) return handleControl(req)
    if (pathname === "/__ready") return new Response("ok")

    if (pathname === "/recover/blank.html") {
      return new Response("<!doctype html><title>blank</title>", {
        headers: { "content-type": "text/html", "cache-control": "no-store" },
      })
    }

    if (pathname === "/version.json") {
      return Response.json({ version: state.latest, buildId: info.generations[state.latest]?.buildId ?? null })
    }

    if (pathname === "/sw.js" && state.failWorker) {
      return new Response("temporary failure", { status: 503 })
    }

    const fp = filePath(pathname)
    if (!fp || !existsSync(fp)) {
      return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } })
    }

    if (state.failAssetPaths.has(pathname)) {
      return new Response("service unavailable", { status: 503 })
    }

    let bytes = readFileSync(fp)
    if (state.corruptAssetPaths.has(pathname)) {
      bytes = Buffer.from(bytes)
      bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff
    }

    return new Response(bytes, {
      headers: {
        "content-type": contentType(fp),
        "cache-control": "no-store",
      },
    })
  },
})

const serverUrl = `http://127.0.0.1:${server.port}`
console.log(`APP_UPDATE_SERVER_URL=${serverUrl}`)
void writeServerPort(server.port)

let cleaningUp = false
function cleanup(): void {
  if (cleaningUp) return
  cleaningUp = true
  server.stop(true)
  rmSync(info.buildRoot, { recursive: true, force: true })
  rmSync(join(__dirname, ".build-info.json"), { force: true })
  rmSync(join(__dirname, ".server-port"), { force: true })
}

process.on("exit", cleanup)
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    cleanup()
    process.exit(0)
  })
}
