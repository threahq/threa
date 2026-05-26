import { describe, expect, test } from "bun:test"
import type { Request } from "express"
import { PI_TOOL_TRACE_FORMAT, PiToolTraceSectionLabels } from "@threa/types"
import { HttpError } from "@threa/backend-common"
import { buildRuntimeWsHint, sanitizeInvocationStepContent } from "./handlers"

function makeRequest(headers: Record<string, string>, protocol = "http"): Request {
  return {
    protocol,
    get(name: string) {
      return headers[name.toLowerCase()]
    },
  } as unknown as Request
}

function parse(content: string) {
  return JSON.parse(content) as Record<string, unknown>
}

describe("sanitizeInvocationStepContent", () => {
  test("drops unknown top-level fields", () => {
    const payload = JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline: "Ran tool",
      sections: [{ label: PiToolTraceSectionLabels.DETAILS, body: "ok", lang: null }],
      leakedSecret: "AKIAABCDEFGHIJKLMNOP",
      attackerMetadata: { token: "ghs_aaaaaaaaaaaaaaaaaaaaaa" },
    })

    const result = parse(sanitizeInvocationStepContent(payload))

    expect(Object.keys(result).sort()).toEqual(["format", "headline", "sections"])
    expect(JSON.stringify(result)).not.toContain("AKIA")
    expect(JSON.stringify(result)).not.toContain("ghs_")
  })

  test("drops unknown per-section fields", () => {
    const payload = JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline: "Ran tool",
      sections: [
        {
          label: PiToolTraceSectionLabels.DETAILS,
          body: "ok",
          lang: null,
          rawOutput: "AKIAABCDEFGHIJKLMNOP",
          customField: { nested: "ghs_aaaaaaaaaaaaaaaaaaaaaa" },
        },
      ],
    })

    const result = parse(sanitizeInvocationStepContent(payload))
    const sections = result.sections as Array<Record<string, unknown>>

    expect(Object.keys(sections[0]!).sort()).toEqual(["body", "label", "lang"])
    expect(JSON.stringify(result)).not.toContain("AKIA")
    expect(JSON.stringify(result)).not.toContain("ghs_")
  })

  test("drops sections with unknown labels", () => {
    const payload = JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline: "Ran tool",
      sections: [
        { label: PiToolTraceSectionLabels.DETAILS, body: "kept", lang: null },
        { label: "Stack trace", body: "AKIAABCDEFGHIJKLMNOP", lang: null },
        { label: "Raw stdout", body: "ghs_aaaaaaaaaaaaaaaaaaaaaa", lang: null },
      ],
    })

    const result = parse(sanitizeInvocationStepContent(payload))
    const sections = result.sections as Array<Record<string, unknown>>

    expect(sections).toHaveLength(1)
    expect(sections[0]!.label).toBe(PiToolTraceSectionLabels.DETAILS)
    expect(JSON.stringify(result)).not.toContain("AKIA")
    expect(JSON.stringify(result)).not.toContain("ghs_")
  })

  test("replaces Arguments/Output/Error output bodies regardless of provided content", () => {
    const payload = JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline: "Ran tool",
      sections: [
        { label: PiToolTraceSectionLabels.ARGUMENTS, body: "AKIAABCDEFGHIJKLMNOP", lang: "json" },
        { label: PiToolTraceSectionLabels.OUTPUT, body: "ghs_aaaaaaaaaaaaaaaaaaaaaa", lang: "text" },
        { label: PiToolTraceSectionLabels.ERROR_OUTPUT, body: "DB_URL=postgres://u:secret@h/d", lang: "text" },
      ],
    })

    const result = parse(sanitizeInvocationStepContent(payload))
    const sections = result.sections as Array<Record<string, unknown>>

    expect(sections[0]!.body).toBe("Tool arguments omitted for safety.")
    expect(sections[1]!.body).toBe("Tool output omitted for safety.")
    expect(sections[2]!.body).toBe("Tool output omitted for safety.")
    expect(JSON.stringify(result)).not.toContain("AKIA")
    expect(JSON.stringify(result)).not.toContain("ghs_")
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("regex-redacts the Details body and the headline", () => {
    const payload = JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline: "AKIAABCDEFGHIJKLMNOP ran tool",
      sections: [{ label: PiToolTraceSectionLabels.DETAILS, body: "Saw AKIAABCDEFGHIJKLMNOP in env", lang: null }],
    })

    const result = parse(sanitizeInvocationStepContent(payload))
    const sections = result.sections as Array<Record<string, unknown>>

    expect(result.headline).toContain("[REDACTED]")
    expect(sections[0]!.body).toContain("[REDACTED]")
    expect(JSON.stringify(result)).not.toContain("AKIA")
  })

  test("caps headline, body, and lang lengths", () => {
    const payload = JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline: "a".repeat(5_000),
      sections: [{ label: PiToolTraceSectionLabels.DETAILS, body: "b".repeat(50_000), lang: "x".repeat(500) }],
    })

    const result = parse(sanitizeInvocationStepContent(payload))
    const sections = result.sections as Array<Record<string, unknown>>

    expect((result.headline as string).length).toBeLessThanOrEqual(200)
    expect((sections[0]!.body as string).length).toBeLessThanOrEqual(10_000)
    expect((sections[0]!.lang as string).length).toBeLessThanOrEqual(32)
  })

  test("caps the number of sections", () => {
    const sections = Array.from({ length: 100 }, () => ({
      label: PiToolTraceSectionLabels.DETAILS,
      body: "ok",
      lang: null,
    }))
    const payload = JSON.stringify({ format: PI_TOOL_TRACE_FORMAT, headline: "Ran tool", sections })

    const result = parse(sanitizeInvocationStepContent(payload))

    expect((result.sections as unknown[]).length).toBeLessThanOrEqual(16)
  })

  test("falls back to plain regex redaction for non-trace JSON", () => {
    const result = sanitizeInvocationStepContent("token=AKIAABCDEFGHIJKLMNOP")
    expect(result).not.toContain("AKIA")
    expect(result).toContain("[REDACTED]")
  })

  test("falls back to plain regex redaction for invalid JSON", () => {
    const result = sanitizeInvocationStepContent("not json AKIAABCDEFGHIJKLMNOP")
    expect(result).not.toContain("AKIA")
    expect(result).toContain("[REDACTED]")
  })
})

describe("buildRuntimeWsHint", () => {
  test("returns the configured URL verbatim when BOT_RUNTIME_WS_URL is set", () => {
    const result = buildRuntimeWsHint(makeRequest({ host: "evil.example.com" }), "wss://prod.threa.io")
    expect(result).toEqual({ url: "wss://prod.threa.io", path: "/socket.io/", namespace: "/bot" })
  })

  test("derives ws:// from loopback Host header in dev when no override is configured", () => {
    const result = buildRuntimeWsHint(makeRequest({ host: "localhost:4000" }), null)
    expect(result).toEqual({ url: "ws://localhost:4000", path: "/socket.io/", namespace: "/bot" })
  })

  test("honors x-forwarded-proto for the scheme on loopback hosts", () => {
    const result = buildRuntimeWsHint(makeRequest({ host: "127.0.0.1:4000", "x-forwarded-proto": "https" }), null)
    expect(result.url).toBe("wss://127.0.0.1:4000")
  })

  test("refuses to advertise a WS endpoint built from a non-loopback Host header", () => {
    // The Host header is attacker-controllable, so the dev fallback must not
    // hand a runtime a spoofed origin to dial with its API key.
    expect(() => buildRuntimeWsHint(makeRequest({ host: "evil.example.com" }), null)).toThrow(HttpError)
  })

  test("refuses when the Host header is a public-looking hostname even if x-forwarded-proto says https", () => {
    expect(() => buildRuntimeWsHint(makeRequest({ host: "api.threa.io", "x-forwarded-proto": "https" }), null)).toThrow(
      HttpError
    )
  })
})
