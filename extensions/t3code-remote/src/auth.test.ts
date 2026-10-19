import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readToken, T3Auth, T3AuthError, writeToken } from "./auth"

const URL_ = "http://t3.test"

/** T3's pairing-code OAuth endpoints; the token endpoint checks the PKCE verifier against the challenge. */
function fakeOAuth(pairingCode = "PAIR-1234") {
  let challenge = ""
  let issued = 0
  const fetch = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    if (path === "/oauth/mcp/register") return Response.json({ client_id: "client_1" })
    if (path === "/oauth/mcp/decision") {
      const body = JSON.parse(String(init.body)) as {
        authorization: { code_challenge: string }
        decision: { _tag: string; code: string; access: string }
      }
      if (body.decision.code !== pairingCode) return Response.json({ error: "bad code" }, { status: 400 })
      challenge = body.authorization.code_challenge
      return Response.json({ redirectTo: `http://127.0.0.1:45999/callback?code=authcode_1&state=x` })
    }
    if (path === "/oauth/mcp/token") {
      const form = new URLSearchParams(String(init.body))
      const verified =
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") === challenge
      if (!verified || form.get("code") !== "authcode_1")
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      return Response.json({ access_token: `tok_${++issued}`, token_type: "Bearer" })
    }
    return new Response("", { status: 404 })
  }
  return { fetch }
}

function tokenPath(): string {
  return join(mkdtempSync(join(tmpdir(), "t3auth-")), "token.json")
}

describe("T3Auth", () => {
  test("reuses the saved token minted by this server at this access", async () => {
    const path = tokenPath()
    writeToken(path, { accessToken: "tok_saved", access: "full-access", url: URL_ })
    const auth = new T3Auth({ url: URL_, access: "full-access", tokenPath: path, autoLogin: false })

    expect(await auth.token()).toBe("tok_saved")
  })

  test("without auto-login a missing or rejected token is an auth error", async () => {
    const path = tokenPath()
    writeToken(path, { accessToken: "tok_other", access: "full-access", url: "http://elsewhere.test" })
    const auth = new T3Auth({ url: URL_, access: "full-access", tokenPath: path, autoLogin: false })

    await expect(auth.token()).rejects.toBeInstanceOf(T3AuthError)
    await expect(auth.renew("tok_other")).rejects.toBeInstanceOf(T3AuthError)
  })

  test("auto-login mints a pairing code, exchanges it and saves the token, once per rejected token", async () => {
    const path = tokenPath()
    let minted = 0
    const auth = new T3Auth({
      url: URL_,
      access: "auto",
      tokenPath: path,
      autoLogin: true,
      fetch: fakeOAuth().fetch,
      mintCode: async () => {
        minted += 1
        return "PAIR-1234"
      },
    })

    expect(await auth.token()).toBe("tok_1")
    expect(await Promise.all([auth.renew("tok_1"), auth.renew("tok_1")])).toEqual(["tok_2", "tok_2"])
    expect(await auth.renew("tok_1")).toBe("tok_2")
    expect({ minted, saved: readToken(path) }).toEqual({
      minted: 2,
      saved: { accessToken: "tok_2", access: "auto", url: URL_ },
    })
  })

  test("login with a refused pairing code saves nothing", async () => {
    const path = tokenPath()
    const auth = new T3Auth({
      url: URL_,
      access: "full-access",
      tokenPath: path,
      autoLogin: true,
      fetch: fakeOAuth().fetch,
    })

    await expect(auth.login("WRONG")).rejects.toThrow("/oauth/mcp/decision answered 400")
    expect(readToken(path)).toBeUndefined()
  })
})
