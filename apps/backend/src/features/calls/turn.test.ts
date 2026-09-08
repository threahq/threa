import { describe, expect, test } from "bun:test"
import { CloudflareTurnIssuer } from "./turn"

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function issuerFor(body: unknown, options: { ttlSeconds?: number; timeoutMs?: number } = {}) {
  return new CloudflareTurnIssuer({ keyId: "key", apiToken: "secret", ...options }, (async () =>
    response(body)) as unknown as typeof fetch)
}

async function expectProviderError(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ code: "CALL_TURN_PROVIDER_ERROR", status: 502 })
}

describe("CloudflareTurnIssuer", () => {
  test("should issue short-lived credentials and remove browser-blocked port 53 URLs", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const turnIssuer = new CloudflareTurnIssuer({ keyId: "key/id", apiToken: "secret", ttlSeconds: 120 }, (async (
      url: string | URL | Request,
      init?: RequestInit
    ) => {
      requests.push({ url: String(url), init })
      return response({
        iceServers: [
          { urls: "stun:stun.example.com:3478" },
          {
            urls: [
              "turn:turn.example.com:53?transport=udp",
              "turn:turn.example.com:3478?transport=udp",
              "turns:turn.example.com:5349?transport=tcp",
            ],
            username: "u",
            credential: "c",
          },
        ],
      })
    }) as unknown as typeof fetch)

    const result = await turnIssuer.issue()

    expect({ requestUrl: requests[0].url, body: requests[0].init?.body, iceServers: result.iceServers }).toEqual({
      requestUrl: "https://rtc.live.cloudflare.com/v1/turn/keys/key%2Fid/credentials/generate-ice-servers",
      body: JSON.stringify({ ttl: 120 }),
      iceServers: [
        { urls: "stun:stun.example.com:3478" },
        {
          urls: ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349?transport=tcp"],
          username: "u",
          credential: "c",
        },
      ],
    })
    expect(result.expiresAt).toBeString()
  })

  test("should compute expiry from request start", async () => {
    const ttlSeconds = 2
    const before = Date.now()
    const turnIssuer = new CloudflareTurnIssuer({ keyId: "key", apiToken: "secret", ttlSeconds }, (async () => {
      await Bun.sleep(30)
      return response({ iceServers: [{ urls: "turn:turn.example.com:3478", username: "u", credential: "c" }] })
    }) as unknown as typeof fetch)

    const result = await turnIssuer.issue()
    const expiresAt = Date.parse(result.expiresAt)

    expect(expiresAt).toBeGreaterThanOrEqual(before + ttlSeconds * 1000)
    expect(expiresAt).toBeLessThan(before + ttlSeconds * 1000 + 20)
  })

  test("should reject malformed provider response shapes and URLs", async () => {
    const invalidBodies = [
      null,
      [],
      {},
      { iceServers: "not-an-array" },
      { iceServers: [{ urls: 42 }] },
      { iceServers: [{ urls: [] }] },
      { iceServers: [{ urls: "https://turn.example.com", username: "u", credential: "c" }] },
      { iceServers: [{ urls: "turn:turn.example.com:70000", username: "u", credential: "c" }] },
      { iceServers: [{ urls: "turn:turn.example.com:3478/path", username: "u", credential: "c" }] },
      { iceServers: [{ urls: "turn:turn.example.com:3478", username: "u", credential: "c", secret: "leak" }] },
      { iceServers: [], hostOnly: true },
    ]

    for (const body of invalidBodies) await expectProviderError(issuerFor(body).issue())
  })

  test("should require credentials on every TURN server", async () => {
    await expectProviderError(issuerFor({ iceServers: [{ urls: "turn:turn.example.com:3478" }] }).issue())
    await expectProviderError(
      issuerFor({ iceServers: [{ urls: "turn:turn.example.com:3478", username: "u" }] }).issue()
    )
    await expectProviderError(
      issuerFor({ iceServers: [{ urls: "turn:turn.example.com:3478", credential: "c" }] }).issue()
    )
  })

  test("should reject empty, STUN-only, and port-53-only responses", async () => {
    await expectProviderError(issuerFor({ iceServers: [] }).issue())
    await expectProviderError(issuerFor({ iceServers: [{ urls: "stun:stun.example.com:3478" }] }).issue())
    await expectProviderError(
      issuerFor({
        iceServers: [{ urls: "turn:turn.example.com:53?transport=tcp", username: "u", credential: "c" }],
      }).issue()
    )
  })

  test("should redact provider details from non-success and malformed responses", async () => {
    const rejected = new CloudflareTurnIssuer({ keyId: "key", apiToken: "secret" }, (async () =>
      response({ error: "provider-secret-detail" }, 401)) as unknown as typeof fetch)
    const malformed = new CloudflareTurnIssuer(
      { keyId: "key", apiToken: "secret" },
      (async () => new Response("provider-secret-detail", { status: 200 })) as unknown as typeof fetch
    )

    for (const turnIssuer of [rejected, malformed]) {
      try {
        await turnIssuer.issue()
        throw new Error("expected issuance to fail")
      } catch (error) {
        expect(String(error)).not.toContain("provider-secret-detail")
        expect(error).toMatchObject({ code: "CALL_TURN_PROVIDER_ERROR", status: 502 })
      }
    }
  })

  test("should time out without exposing fetch errors", async () => {
    const turnIssuer = new CloudflareTurnIssuer(
      { keyId: "key", apiToken: "secret", timeoutMs: 10 },
      (async (_url: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("provider-secret-detail")), { once: true })
        })) as unknown as typeof fetch
    )

    try {
      await turnIssuer.issue()
      throw new Error("expected issuance to fail")
    } catch (error) {
      expect(String(error)).not.toContain("provider-secret-detail")
      expect(error).toMatchObject({ code: "CALL_TURN_UNAVAILABLE", status: 503 })
    }
  })
})
