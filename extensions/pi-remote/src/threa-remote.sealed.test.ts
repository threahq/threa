import { afterEach, describe, expect, test } from "bun:test"
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import { __testing } from "./threa-remote"

// The full-vs-redacted trace policy for sealed (E2EE) turns. The crypto itself
// (BIK, claim hydration, seal/open) is covered by @threa/bot-runtime-client's
// suite; these tests pin the harness-side policy: full detail is emitted ONLY
// when the turn is sealed, and the config toggle can only opt a sealed turn
// back to redacted — never unlock full detail for plaintext.

type SealedInvocation = Parameters<typeof __testing.shouldEmitFullTrace>[0]

const BASE_CONFIG = { baseUrl: "https://x", workspaceId: "ws_1", apiKey: "k" }

const sealingState = {
  streamId: "stream_root",
  replyKeyGeneration: 1,
  replySenderId: "bot_1",
  replySsk: new Uint8Array(32),
  callbackToken: "cb",
}

function invocation(overrides: Record<string, unknown> = {}): SealedInvocation {
  return {
    id: "binv_1",
    activeStreamId: "stream_a",
    sourceMessageId: "msg_1",
    promptMarkdown: "hi",
    claimToken: "tok",
    claimExpiresAt: null,
    ...overrides,
  } as SealedInvocation
}

function bashCall(command: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "tc_1", toolName: "bash", input: { command } } as unknown as ToolCallEvent
}

function bashResult(output: string, isError = false): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "tc_1",
    toolName: "bash",
    isError,
    content: [{ type: "text", text: output }],
  } as unknown as ToolResultEvent
}

afterEach(() => __testing.setConfigForTesting(undefined))

describe("shouldEmitFullTrace", () => {
  test("true only for a sealed turn with the toggle unset or on", () => {
    __testing.setConfigForTesting(BASE_CONFIG)
    expect(__testing.shouldEmitFullTrace(invocation({ sealing: sealingState }))).toBe(true)
    __testing.setConfigForTesting({ ...BASE_CONFIG, sealedFullTrace: true })
    expect(__testing.shouldEmitFullTrace(invocation({ sealing: sealingState }))).toBe(true)
  })

  test("the toggle opts a sealed turn back to redacted", () => {
    __testing.setConfigForTesting({ ...BASE_CONFIG, sealedFullTrace: false })
    expect(__testing.shouldEmitFullTrace(invocation({ sealing: sealingState }))).toBe(false)
  })

  test("never true for a plaintext turn, whatever the toggle says", () => {
    __testing.setConfigForTesting({ ...BASE_CONFIG, sealedFullTrace: true })
    expect(__testing.shouldEmitFullTrace(invocation())).toBe(false)
    expect(__testing.shouldEmitFullTrace(undefined)).toBe(false)
  })
})

describe("full trace detail (sealed turns)", () => {
  test("tool_call carries the real shell command when full", () => {
    const payload = JSON.parse(__testing.formatToolCallTrace(bashCall("rm -rf ./build && make"), true)) as {
      sections: Array<{ label: string; body: string; lang: string | null }>
    }
    expect(payload.sections).toEqual([{ label: "Arguments", body: "rm -rf ./build && make", lang: "bash" }])
  })

  test("tool_call stays redacted by default (missed call sites fail safe)", () => {
    const payload = JSON.parse(__testing.formatToolCallTrace(bashCall("secret command"))) as {
      sections: Array<{ body: string }>
    }
    expect(payload.sections[0]!.body).toBe("Shell command omitted for safety.")
    expect(JSON.stringify(payload)).not.toContain("secret command")
  })

  test("tool_result carries the real output when full, a size summary otherwise", () => {
    const full = JSON.parse(__testing.formatToolResultTrace(bashResult("total 42\n-rw-r--r-- secrets.txt"), true)) as {
      sections: Array<{ label: string; body: string }>
    }
    expect(full.sections[0]).toMatchObject({ label: "Output", body: "total 42\n-rw-r--r-- secrets.txt" })

    const redacted = JSON.parse(__testing.formatToolResultTrace(bashResult("total 42\n-rw-r--r-- secrets.txt"))) as {
      sections: Array<{ body: string }>
    }
    expect(redacted.sections[0]!.body).toContain("omitted for safety")
    expect(JSON.stringify(redacted)).not.toContain("secrets.txt")
  })

  test("tool errors keep real details when full, drop them when redacted", () => {
    const full = JSON.parse(
      __testing.formatToolResultTrace(bashResult("ENOENT: /home/kris/.aws/credentials", true), true)
    ) as { sections: Array<{ label: string; body: string }> }
    expect(full.sections[0]).toMatchObject({ label: "Error output", body: "ENOENT: /home/kris/.aws/credentials" })

    const redacted = JSON.parse(
      __testing.formatToolResultTrace(bashResult("ENOENT: /home/kris/.aws/credentials", true))
    ) as { sections: Array<{ body: string }> }
    expect(JSON.stringify(redacted)).not.toContain(".aws")
  })

  test("non-bash args serialize as pretty JSON when full", () => {
    const event = {
      type: "tool_call",
      toolCallId: "tc_2",
      toolName: "edit",
      input: { path: "src/index.ts", patch: "- a\n+ b" },
    } as unknown as ToolCallEvent
    const { body, lang } = __testing.fullToolArgumentSummary(event)
    expect(lang).toBe("json")
    expect(JSON.parse(body)).toEqual({ path: "src/index.ts", patch: "- a\n+ b" })
  })

  test("a full trace uses the roomier sealed clamp instead of the 10K plaintext cap", () => {
    const bigOutput = "x".repeat(30_000)
    const payload = __testing.formatToolResultTrace(bashResult(bigOutput), true)
    expect(payload.length).toBeGreaterThan(10_000)
    expect(payload).toContain(bigOutput.slice(0, 1000))
  })
})
