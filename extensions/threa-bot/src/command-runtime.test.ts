import { describe, expect, test } from "bun:test"
import { CommandRuntime, describeOutcome, MAX_OUTPUT_CHARS } from "./command-runtime"

describe("CommandRuntime", () => {
  test("pipes the turn to stdin and returns stdout, streaming stderr lines", async () => {
    const lines: string[] = []
    const runtime = new CommandRuntime({
      command: ["sh", "-c", 'echo "step one" >&2; echo "step two" >&2; echo "Echo: $(cat) [$THREA_INVOCATION_ID]"'],
    })
    runtime.onStderrLine = (line) => lines.push(line)
    const outcome = await runtime.run("hello", { THREA_INVOCATION_ID: "binv_1" })
    expect(outcome).toEqual({ ok: true, stdout: "Echo: hello [binv_1]\n", truncated: false })
    expect(lines).toEqual(["step one", "step two"])
    expect(runtime.busy).toBe(false)
  })

  test("reports a non-zero exit with the stderr tail", async () => {
    const runtime = new CommandRuntime({ command: ["sh", "-c", "echo boom >&2; exit 3"] })
    const outcome = await runtime.run("x")
    expect(outcome).toEqual({ ok: false, reason: "exit", code: 3, signal: null, stderr: "boom\n" })
    expect(describeOutcome(outcome, ["sh"])).toBe("`sh` exited with code 3.\n\n```\nboom\n```")
  })

  test("interrupt kills the running command and the outcome carries no reply", async () => {
    const runtime = new CommandRuntime({ command: ["sh", "-c", "sleep 30; echo late"] })
    const pending = runtime.run("x")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(runtime.busy).toBe(true)
    expect(runtime.interrupt()).toBe(true)
    const outcome = await pending
    expect(outcome).toEqual({ ok: false, reason: "interrupted" })
    expect(describeOutcome(outcome, ["sh"])).toBeUndefined()
  })

  test("a run issued right after an interrupt waits for the old process to die instead of throwing", async () => {
    const runtime = new CommandRuntime({ command: ["sh", "-c", 'read -r line; sleep 30; echo "late $line"'] })
    const first = runtime.run("one")
    await new Promise((resolve) => setTimeout(resolve, 100))
    runtime.interrupt()
    const second = runtime.run("two")
    await expect(first).resolves.toEqual({ ok: false, reason: "interrupted" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    runtime.interrupt()
    await expect(second).resolves.toEqual({ ok: false, reason: "interrupted" })
    // A run against a live, un-interrupted command is still a caller bug.
    const third = runtime.run("three")
    await new Promise((resolve) => setTimeout(resolve, 100))
    await expect(runtime.run("four")).rejects.toThrow("already running")
    runtime.interrupt()
    await third
  })

  test("a turn timeout kills the command and says so", async () => {
    const runtime = new CommandRuntime({ command: ["sh", "-c", "sleep 30"], timeoutMs: 100 })
    const outcome = await runtime.run("x")
    expect(outcome).toEqual({ ok: false, reason: "timeout", stderr: "" })
    expect(describeOutcome(outcome, ["sleepy"])).toBe("`sleepy` was stopped after the turn timeout.")
  })

  test("a command that cannot start is reported, not thrown", async () => {
    const runtime = new CommandRuntime({ command: ["/nonexistent/agent"] })
    const outcome = await runtime.run("x")
    expect(outcome.ok).toBe(false)
    expect((outcome as { reason: string }).reason).toBe("spawn")
    expect(describeOutcome(outcome, ["/nonexistent/agent"])).toStartWith("Could not start `/nonexistent/agent`")
  })

  test("caps stdout at the reply limit and marks the truncation", async () => {
    const runtime = new CommandRuntime({
      command: ["sh", "-c", `head -c ${MAX_OUTPUT_CHARS + 5000} /dev/zero | tr '\\0' a`],
    })
    const outcome = await runtime.run("x")
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error("unreachable")
    expect(outcome.stdout.length).toBe(MAX_OUTPUT_CHARS)
    expect(outcome.truncated).toBe(true)
    expect(describeOutcome(outcome, ["sh"])).toEndWith(`_Output truncated at ${MAX_OUTPUT_CHARS} characters._`)
  })
})
