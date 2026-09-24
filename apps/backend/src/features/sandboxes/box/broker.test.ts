import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import http from "node:http"
import net, { type AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startBroker } from "./broker"

const WS = "ws_broker"
const TOKEN = "threa_sk_secret"

interface Seen {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: string
}

function listening(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    if (server.listening) resolve((server.address() as AddressInfo).port)
    else server.once("listening", () => resolve((server.address() as AddressInfo).port))
  })
}

// URL parsing (fetch, and Bun's node:http) normalizes dot segments and
// backslashes, so the request line is written by hand.
function rawStatus(base: string, path: string): Promise<number> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`)
    })
    let head = ""
    socket.on("data", (chunk) => (head += chunk.toString()))
    socket.on("end", () => resolve(Number(head.split(" ")[1])))
    socket.on("error", reject)
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe("sandbox API broker", () => {
  const seen: Seen[] = []
  const socketDir = mkdtempSync(join(tmpdir(), "broker-test-"))
  const socketPath = join(socketDir, "api.sock")
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    seen.push({ method: req.method!, path: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() })
    if (req.url!.endsWith("/redirect")) {
      res.writeHead(302, { location: "https://elsewhere.example/", "set-cookie": "a=b", "content-type": "text/plain" })
      res.end("moved")
      return
    }
    res.writeHead(200, {
      "content-type": "text/csv",
      "content-disposition": 'attachment; filename="out.csv"',
      "x-internal": "1",
    })
    res.end("x,y\n1,2\n")
  })
  const socketUpstream = http.createServer((req, res) => {
    seen.push({ method: req.method!, path: req.url!, headers: req.headers, body: "" })
    res.end("via socket")
  })
  let tcpBroker: http.Server
  let socketBroker: http.Server
  let deadBroker: http.Server
  let tcpBase: string
  let socketBase: string
  let deadBase: string

  beforeAll(async () => {
    upstream.listen(0, "127.0.0.1")
    socketUpstream.listen(socketPath)
    const upstreamPort = await listening(upstream)
    tcpBroker = startBroker({ token: TOKEN, workspaceId: WS, upstream: `http://127.0.0.1:${upstreamPort}`, port: 0 })
    socketBroker = startBroker({ token: TOKEN, workspaceId: WS, upstream: `unix:${socketPath}`, port: 0 })
    deadBroker = startBroker({ token: TOKEN, workspaceId: WS, upstream: "http://127.0.0.1:1", port: 0 })
    tcpBase = `http://127.0.0.1:${await listening(tcpBroker)}`
    socketBase = `http://127.0.0.1:${await listening(socketBroker)}`
    deadBase = `http://127.0.0.1:${await listening(deadBroker)}`
  })

  afterAll(async () => {
    await Promise.all([tcpBroker, socketBroker, deadBroker, upstream, socketUpstream].map(close))
    rmSync(socketDir, { recursive: true, force: true })
  })

  test("should forward a workspace call with the token in place of the caller's credentials", async () => {
    seen.length = 0
    const res = await fetch(`${tcpBase}/api/v1/workspaces/${WS}/attachments?x=1`, {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox",
        cookie: "session=1",
        "x-forwarded-for": "1.2.3.4",
        "content-type": "text/plain",
      },
      body: "payload",
    })

    expect({
      status: res.status,
      body: await res.text(),
      headers: Object.fromEntries(res.headers),
      upstream: seen.map((s) => ({
        ...s,
        headers: {
          authorization: s.headers.authorization,
          cookie: s.headers.cookie,
          xff: s.headers["x-forwarded-for"],
          type: s.headers["content-type"],
        },
      })),
    }).toEqual({
      status: 200,
      body: "x,y\n1,2\n",
      headers: expect.objectContaining({
        "content-type": "text/csv",
        "content-disposition": 'attachment; filename="out.csv"',
      }),
      upstream: [
        {
          method: "POST",
          path: `/api/v1/workspaces/${WS}/attachments?x=1`,
          headers: { authorization: `Bearer ${TOKEN}`, cookie: undefined, xff: undefined, type: "text/plain" },
          body: "payload",
        },
      ],
    })
    expect(res.headers.get("x-internal")).toBeNull()
  })

  test("should pass a redirect through without its location or cookies", async () => {
    const res = await fetch(`${tcpBase}/api/v1/workspaces/${WS}/redirect`, { redirect: "manual" })
    expect({
      status: res.status,
      location: res.headers.get("location"),
      cookie: res.headers.get("set-cookie"),
    }).toEqual({
      status: 302,
      location: null,
      cookie: null,
    })
  })

  test("should refuse paths outside the workspace API without calling upstream", async () => {
    seen.length = 0
    const paths = [
      "/api/v1/workspaces/ws_other/streams",
      "/api/v1/workspaces/ws_broker",
      "/health",
      `/api/v1/workspaces/${WS}/../ws_other/streams`,
      `/api/v1/workspaces/${WS}/%2e%2e/ws_other/streams`,
      `/api/v1/workspaces/${WS}/%2E./x`,
      `/api/v1/workspaces/${WS}/./streams`,
      `/api/v1/workspaces/${WS}/..`,
      `/api/v1/workspaces/${WS}/a\\..\\b`,
      `/api/v1/workspaces/${WS}/..#`,
    ]
    const statuses = await Promise.all(paths.map((path) => rawStatus(tcpBase, path)))
    expect({ statuses, upstreamCalls: seen.length }).toEqual({ statuses: paths.map(() => 404), upstreamCalls: 0 })
  })

  test("should reach a unix-socket upstream", async () => {
    seen.length = 0
    const res = await fetch(`${socketBase}/api/v1/workspaces/${WS}/streams`)
    expect({ status: res.status, body: await res.text(), auth: seen[0]?.headers.authorization }).toEqual({
      status: 200,
      body: "via socket",
      auth: `Bearer ${TOKEN}`,
    })
  })

  test("should answer 502 when upstream is unreachable", async () => {
    const res = await fetch(`${deadBase}/api/v1/workspaces/${WS}/streams`)
    expect(res.status).toBe(502)
  })
})
