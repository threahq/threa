import { createServer } from "node:http"
import { once } from "node:events"
import { test, expect } from "@playwright/test"
import { devLogin, expectApiOk, generateTestId } from "./helpers"

test("should authenticate fixture accounts when the dev proxy rejects login writes", async ({ browser, baseURL }) => {
  const proxy = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain" })
    response.end("Your worker restarted mid-request. Please try sending the request again.")
  })
  proxy.listen(0, "localhost")
  await once(proxy, "listening")
  try {
    const address = proxy.address()
    if (!address || typeof address === "string") throw new Error("Fixture proxy did not bind a TCP port")
    const context = await browser.newContext({ baseURL: `http://localhost:${address.port}` })
    try {
      const page = await context.newPage()
      const testId = generateTestId()
      for (const intent of [undefined, "add"] as const) {
        const email = `fixture-${intent ?? "login"}-${testId}@example.com`
        const user = await devLogin(page, email, "Fixture account", { intent })
        const response = await context.request.get(`${baseURL}/api/auth/me`)
        await expectApiOk(response, "Read fixture identity through the real router")
        expect(await response.json()).toMatchObject({ id: user.id, email, name: "Fixture account" })
      }
    } finally {
      await context.close()
    }
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())))
  }
})
