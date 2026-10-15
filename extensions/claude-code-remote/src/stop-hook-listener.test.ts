import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StopHookListener, parseStopHookPayload, readTranscriptTurn, type StopHookSignal } from "./stop-hook-listener"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "threa-stop-hook-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function runForwarder(socketPath: string, payload: string) {
  return Bun.spawn(["bun", join(import.meta.dir, "stop-hook-forwarder.ts"), socketPath], {
    stdin: new Blob([payload]),
    stdout: "pipe",
    stderr: "pipe",
  })
}

describe("stop-hook forwarder", () => {
  test("exits 0 silently when the channel socket is absent", async () => {
    const hook = runForwarder(join(dir, "missing.sock"), JSON.stringify({ hook_event_name: "Stop" }))

    expect({
      exitCode: await hook.exited,
      stdout: await new Response(hook.stdout).text(),
      stderr: await new Response(hook.stderr).text(),
    }).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  test("delivers the hook payload to a listening channel, replacing a stale socket file", async () => {
    const socketPath = join(dir, "session.sock")
    writeFileSync(socketPath, "stale")
    const listener = await StopHookListener.listen(socketPath, () => {})
    const received = new Promise<StopHookSignal>((resolve) => listener.onSignal(resolve))

    const hook = runForwarder(
      socketPath,
      JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: "Limit hit" })
    )

    expect({ exitCode: await hook.exited, signal: await received }).toEqual({
      exitCode: 0,
      signal: { event: "StopFailure", transcriptPath: undefined, error: "rate_limit", message: "Limit hit" },
    })
    await listener.close()
  })
})

describe("StopHookListener.listen", () => {
  test("rejects when the path cannot be bound", async () => {
    await expect(StopHookListener.listen(join(dir, "no-such-dir", "session.sock"), () => {})).rejects.toThrow()
  })
})

describe("parseStopHookPayload", () => {
  test("reads Stop fields and ignores blanks and other events", () => {
    expect([
      parseStopHookPayload(
        JSON.stringify({ hook_event_name: "Stop", transcript_path: "/t.jsonl", last_assistant_message: "  " })
      ),
      parseStopHookPayload(JSON.stringify({ hook_event_name: "PreToolUse" })),
      parseStopHookPayload("not json"),
    ]).toEqual([{ event: "Stop", transcriptPath: "/t.jsonl", lastAssistantMessage: undefined }, undefined, undefined])
  })

  test("prefers the shown StopFailure text over the raw provider error", () => {
    expect(
      parseStopHookPayload(
        JSON.stringify({
          hook_event_name: "StopFailure",
          error: "rate_limit",
          error_details: '429 {"type":"error","error":{"type":"rate_limit_error"}}',
          last_assistant_message: "You've hit your limit · resets 3pm (UTC)",
        })
      )
    ).toEqual({
      event: "StopFailure",
      transcriptPath: undefined,
      error: "rate_limit",
      message: "You've hit your limit · resets 3pm (UTC)",
    })
  })
})

describe("readTranscriptTurn", () => {
  const id = "binv_01turn"
  const turnLine = `{"type":"user","message":{"content":"<channel invocation_id=\\"${id}\\">go</channel>"}}`
  const queueLine = (operation: string, content?: string) =>
    JSON.stringify({ type: "queue-operation", operation, timestamp: "2026-10-15T08:00:00.000Z", content })
  const read = async (lines: string[]) => {
    const path = join(dir, "transcript.jsonl")
    writeFileSync(path, `${lines.join("\n")}\n`)
    return readTranscriptTurn(path, id)
  }

  test("finds an id that straddles a scan chunk boundary and misses an absent one", async () => {
    const path = join(dir, "transcript.jsonl")
    const straddler = "binv_01straddle"
    writeFileSync(path, `${"x".repeat((1 << 20) * 2 - 5)}${straddler}${"y".repeat((1 << 20) - 10)}`)

    expect([await readTranscriptTurn(path, straddler), await readTranscriptTurn(path, "binv_absent")]).toEqual([
      { seen: true, pendingInput: false },
      { seen: false, pendingInput: false },
    ])
  })

  test("reads queue state across chunks and only counts taken turns as seen", async () => {
    const padding = `{"type":"assistant","text":"${"z".repeat(1 << 20)}"}`
    expect([
      await read([queueLine("enqueue", `<channel invocation_id="${id}">go</channel>`)]),
      await read([turnLine, queueLine("enqueue", "steer"), queueLine("dequeue")]),
      await read([turnLine, queueLine("enqueue", "steer"), queueLine("remove", "steer")]),
      await read([queueLine("dequeue"), turnLine, queueLine("enqueue", "steer")]),
      await read([turnLine, padding, padding, queueLine("enqueue", "steer"), padding]),
    ]).toEqual([
      { seen: false, pendingInput: true },
      { seen: true, pendingInput: false },
      { seen: true, pendingInput: false },
      { seen: true, pendingInput: true },
      { seen: true, pendingInput: true },
    ])
  })

  test("replays the queue oldest first from the turn's earliest mention", async () => {
    const notification = "<task-notification>done</task-notification>"
    expect([
      await read([queueLine("enqueue", notification), turnLine]),
      await read([queueLine("enqueue", notification), turnLine, queueLine("remove", notification)]),
      await read([queueLine("enqueue", notification), turnLine, queueLine("dequeue"), queueLine("enqueue", "steer")]),
      await read([turnLine, queueLine("enqueue", "a"), queueLine("enqueue", "b"), queueLine("dequeue")]),
    ]).toEqual([
      { seen: true, pendingInput: false },
      { seen: true, pendingInput: false },
      { seen: true, pendingInput: true },
      { seen: true, pendingInput: true },
    ])
  })

  test("Claude's own tool calls carrying the id do not anchor the replay", async () => {
    const send = JSON.stringify({ type: "assistant", tool_use: { name: "send", input: { invocation_id: id } } })
    const padding = `{"type":"assistant","text":"${"z".repeat(1 << 20)}"}`
    expect([
      await read([turnLine, queueLine("enqueue", "steer"), send]),
      await read([turnLine, ...Array(5).fill(padding), queueLine("enqueue", "steer"), send]),
    ]).toEqual([
      { seen: true, pendingInput: true },
      { seen: true, pendingInput: true },
    ])
  })
})
