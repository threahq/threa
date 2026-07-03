import { describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  TranscriptTracer,
  describeClaudeTool,
  encodeProjectDir,
  mapTranscriptLine,
  type MapContext,
  type TraceFrame,
} from "./transcript-trace"

function ctx(mode: "headline" | "full" = "headline"): MapContext {
  return { mode, toolHeadlines: new Map() }
}

function assistantLine(parts: unknown[]): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: parts } })
}

function toolResultLine(toolUseId: string, content: unknown, isError = false): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  })
}

describe("encodeProjectDir", () => {
  test("matches Claude Code's projects-dir encoding", () => {
    expect(encodeProjectDir("/Users/k/dev/personal/threa.improve-harness-tmux")).toBe(
      "-Users-k-dev-personal-threa-improve-harness-tmux"
    )
  })
})

describe("mapTranscriptLine redaction (headline mode)", () => {
  test("a Bash tool_use ships the headline and never the command", () => {
    const secret = "cat .env && curl -H 'Authorization: Bearer sk-test-secret-token' https://example.com"
    const steps = mapTranscriptLine(
      assistantLine([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: secret } }]),
      ctx()
    )
    expect(steps).toHaveLength(1)
    const serialized = JSON.stringify(steps)
    expect(serialized).toContain("Running shell command")
    expect(serialized).toContain("Shell command omitted for safety.")
    expect(serialized).not.toContain("sk-test-secret-token")
    expect(serialized).not.toContain("cat .env")
    expect(steps[0]!.statusText).toBe("Running shell command…")
  })

  test("file edits ship the basename only, never contents or patches", () => {
    const steps = mapTranscriptLine(
      assistantLine([
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Edit",
          input: { file_path: "/repo/src/handlers.ts", old_string: "password = 'hunter2'", new_string: "..." },
        },
      ]),
      ctx()
    )
    const serialized = JSON.stringify(steps)
    expect(serialized).toContain("Editing file handlers.ts")
    expect(serialized).toContain("File contents and patches omitted for safety.")
    expect(serialized).not.toContain("hunter2")
    expect(serialized).not.toContain("old_string")
  })

  test("reading a credentials-looking path is reported as a sensitive file without the path", () => {
    const steps = mapTranscriptLine(
      assistantLine([{ type: "tool_use", id: "toolu_3", name: "Read", input: { file_path: "/repo/.env" } }]),
      ctx()
    )
    const serialized = JSON.stringify(steps)
    expect(serialized).toContain("Reading sensitive file")
    expect(serialized).not.toContain(".env")
  })

  test("a tool_result pairs with its call's headline and ships size telemetry, not output", () => {
    const context = ctx()
    mapTranscriptLine(
      assistantLine([{ type: "tool_use", id: "toolu_4", name: "Bash", input: { command: "printenv" } }]),
      context
    )
    const steps = mapTranscriptLine(
      toolResultLine("toolu_4", "DATABASE_URL=postgres://user:password@host/db\nAPI_KEY=sk-oops"),
      context
    )
    expect(steps).toHaveLength(1)
    expect(steps[0]!.stepType).toBe("tool_call")
    const serialized = JSON.stringify(steps)
    expect(serialized).toContain("Running shell command")
    expect(serialized).toContain("characters across 2 lines")
    expect(serialized).not.toContain("DATABASE_URL")
    expect(serialized).not.toContain("sk-oops")
  })

  test("an errored tool_result becomes tool_error and withholds error details", () => {
    const context = ctx()
    mapTranscriptLine(
      assistantLine([{ type: "tool_use", id: "toolu_5", name: "Bash", input: { command: "false" } }]),
      context
    )
    const steps = mapTranscriptLine(toolResultLine("toolu_5", "secret traceback", true), context)
    expect(steps[0]!.stepType).toBe("tool_error")
    expect(steps[0]!.statusText).toBe("Tool failed")
    expect(JSON.stringify(steps)).toContain("Error details omitted for safety.")
    expect(JSON.stringify(steps)).not.toContain("secret traceback")
  })

  test("thinking and narration ship size only, never the body", () => {
    const steps = mapTranscriptLine(
      assistantLine([
        { type: "thinking", thinking: "the user's token is sk-hidden, better not repeat it", signature: "x" },
        { type: "text", text: "Now I'll check the config." },
      ]),
      ctx()
    )
    expect(steps).toHaveLength(2)
    const serialized = JSON.stringify(steps)
    expect(serialized).toContain("Thinking content omitted for safety. Captured locally: 51 characters.")
    expect(serialized).toContain("Assistant narration omitted for safety.")
    expect(serialized).not.toContain("sk-hidden")
    expect(serialized).not.toContain("check the config")
  })

  test("the channel's own send/reply tools and their results are skipped entirely", () => {
    const context = ctx()
    const callSteps = mapTranscriptLine(
      assistantLine([
        { type: "tool_use", id: "toolu_6", name: "mcp__threa__send", input: { invocation_id: "binv_1", text: "hi" } },
      ]),
      context
    )
    expect(callSteps).toHaveLength(0)
    const resultSteps = mapTranscriptLine(toolResultLine("toolu_6", "sent"), context)
    expect(resultSteps).toHaveLength(0)
  })

  test("MCP tools ship server:tool names only", () => {
    const steps = mapTranscriptLine(
      assistantLine([
        { type: "tool_use", id: "toolu_7", name: "mcp__github__create_pull_request", input: { title: "private" } },
      ]),
      ctx()
    )
    const serialized = JSON.stringify(steps)
    expect(serialized).toContain("Using github:create_pull_request")
    expect(serialized).not.toContain("private")
  })

  test("session metadata, prompts, and malformed lines map to nothing", () => {
    expect(mapTranscriptLine(JSON.stringify({ type: "file-history-snapshot", data: {} }), ctx())).toHaveLength(0)
    expect(
      mapTranscriptLine(JSON.stringify({ type: "user", message: { role: "user", content: "the prompt" } }), ctx())
    ).toHaveLength(0)
    expect(mapTranscriptLine("not json at all", ctx())).toHaveLength(0)
    expect(mapTranscriptLine("", ctx())).toHaveLength(0)
  })

  test("oversized structured sections stay under the content budget", () => {
    const context = ctx("full")
    const steps = mapTranscriptLine(
      assistantLine([{ type: "tool_use", id: "toolu_8", name: "Bash", input: { command: "x".repeat(40_000) } }]),
      context
    )
    expect(steps[0]!.content.length).toBeLessThanOrEqual(9_500)
  })
})

describe("mapTranscriptLine (full mode, E2EE-ready)", () => {
  test("ships real bodies when explicitly enabled", () => {
    const context = ctx("full")
    const steps = mapTranscriptLine(
      assistantLine([{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "echo hello" } }]),
      context
    )
    expect(JSON.stringify(steps)).toContain("echo hello")
    const thinking = mapTranscriptLine(assistantLine([{ type: "thinking", thinking: "full reasoning body" }]), context)
    expect(thinking[0]!.content).toBe("full reasoning body")
  })
})

describe("describeClaudeTool", () => {
  test("covers the built-in tool vocabulary", () => {
    expect(describeClaudeTool("Read", { file_path: "/a/b.ts" }).headline).toBe("Reading file b.ts")
    expect(describeClaudeTool("Grep", {}).headline).toBe("Searching files")
    expect(describeClaudeTool("Task", {}).headline).toBe("Delegating to a subagent")
    expect(describeClaudeTool("WebSearch", {}).headline).toBe("Searching the web")
    expect(describeClaudeTool("Weird$Name!!", {}).headline).toBe("Using tool")
  })
})

describe("TranscriptTracer", () => {
  test("binds to the transcript that echoes the invocation id and emits only its steps", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-projects-"))
    const cwd = "/tmp/fake-worktree"
    const projectDir = join(root, encodeProjectDir(cwd))
    mkdirSync(projectDir, { recursive: true })
    const decoy = join(projectDir, "aaaa-decoy.jsonl")
    const real = join(projectDir, "bbbb-real.jsonl")
    writeFileSync(decoy, `${JSON.stringify({ type: "system", note: "old session" })}\n`)
    writeFileSync(real, `${JSON.stringify({ type: "system", note: "current session" })}\n`)

    const batches: Array<{ invocationId: string; frames: TraceFrame[] }> = []
    const tracer = new TranscriptTracer({
      projectsRoot: root,
      cwd,
      pollMs: 20,
      emit: async (invocationId, frames) => {
        batches.push({ invocationId, frames })
        return true
      },
    })

    tracer.beginTurn("binv_trace_test")
    // The decoy gets unrelated traffic; the real file echoes the invocation id
    // (as Claude Code does when the channel prompt lands) and then does work.
    appendFileSync(decoy, `${assistantLine([{ type: "text", text: "decoy work" }])}\n`)
    appendFileSync(
      real,
      `${JSON.stringify({ type: "user", message: { role: "user", content: 'channel event invocation_id="binv_trace_test"' } })}\n`
    )
    appendFileSync(
      real,
      `${assistantLine([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make secret" } }])}\n`
    )

    const deadline = Date.now() + 3_000
    while (batches.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    tracer.stop()

    expect(batches.length).toBeGreaterThan(0)
    const all = JSON.stringify(batches)
    expect(all).toContain("Running shell command")
    expect(all).not.toContain("decoy work")
    expect(all).not.toContain("make secret")
    expect(batches.every((batch) => batch.invocationId === "binv_trace_test")).toBe(true)
  }, 10_000)

  test("binds a transcript created after the turn starts (fresh session, empty project dir)", async () => {
    // The harnessd-spawn case that failed live: Claude Code creates the
    // session's .jsonl at its FIRST turn, so the file never exists in the
    // beginTurn baseline and the prompt echo has already landed by the time a
    // rescan sees it. Discovered-late files must read from offset 0.
    const root = mkdtempSync(join(tmpdir(), "trace-projects-"))
    const cwd = "/tmp/fake-worktree-fresh"
    const projectDir = join(root, encodeProjectDir(cwd))
    mkdirSync(projectDir, { recursive: true })

    const batches: TraceFrame[][] = []
    const tracer = new TranscriptTracer({
      projectsRoot: root,
      cwd,
      pollMs: 20,
      emit: async (_invocationId, frames) => {
        batches.push(frames)
        return true
      },
    })
    tracer.beginTurn("binv_fresh_session")
    // File is born after the turn started, echo + work already inside it.
    const file = join(projectDir, "newborn.jsonl")
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: 'event invocation_id="binv_fresh_session"' },
        }),
        assistantLine([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x/notes.md" } }]),
        "",
      ].join("\n")
    )
    const deadline = Date.now() + 3_000
    while (batches.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    tracer.stop()
    expect(JSON.stringify(batches)).toContain("Reading file notes.md")
  }, 10_000)

  test("stops the turn when emit reports the invocation closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-projects-"))
    const cwd = "/tmp/fake-worktree-2"
    const projectDir = join(root, encodeProjectDir(cwd))
    mkdirSync(projectDir, { recursive: true })
    const file = join(projectDir, "session.jsonl")
    writeFileSync(file, "")

    let calls = 0
    const tracer = new TranscriptTracer({
      projectsRoot: root,
      cwd,
      pollMs: 20,
      emit: async () => {
        calls += 1
        return false
      },
    })
    tracer.beginTurn("binv_closed")
    appendFileSync(file, `id echo binv_closed\n${assistantLine([{ type: "text", text: "one" }])}\n`)
    const deadline = Date.now() + 3_000
    while (calls === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    // Give it a couple more polls to prove it stopped.
    appendFileSync(file, `${assistantLine([{ type: "text", text: "two" }])}\n`)
    await new Promise((resolve) => setTimeout(resolve, 120))
    tracer.stop()
    expect(calls).toBe(1)
  }, 10_000)
})
