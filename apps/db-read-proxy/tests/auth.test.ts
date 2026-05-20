import { describe, expect, test } from "bun:test"
import express from "express"
import { createSecretAuthMiddleware, PROXY_SECRET_HEADER } from "../src/auth"

const SECRET = "x".repeat(40)

function buildApp(): express.Express {
  const app = express()
  app.use(createSecretAuthMiddleware(SECRET))
  app.get("/protected", (_req, res) => {
    res.json({ ok: true })
  })
  return app
}

async function call(app: express.Express, header?: string): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0)
  try {
    const addr = server.address()
    if (!addr || typeof addr === "string") throw new Error("no address")
    const url = `http://127.0.0.1:${addr.port}/protected`
    const res = await fetch(url, { headers: header == null ? {} : { [PROXY_SECRET_HEADER]: header } })
    return { status: res.status, body: await res.json() }
  } finally {
    server.close()
  }
}

describe("secret auth middleware", () => {
  test("401 when header missing", async () => {
    const r = await call(buildApp())
    expect(r.status).toBe(401)
  })

  test("401 when header wrong", async () => {
    const r = await call(buildApp(), "y".repeat(40))
    expect(r.status).toBe(401)
  })

  test("401 when header has wrong length (does not crash on timingSafeEqual)", async () => {
    const r = await call(buildApp(), "short")
    expect(r.status).toBe(401)
  })

  test("200 when header matches exactly", async () => {
    const r = await call(buildApp(), SECRET)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
  })
})
