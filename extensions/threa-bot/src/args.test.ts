import { describe, expect, test } from "bun:test"
import { parseCliArgs } from "./args"

describe("parseCliArgs", () => {
  test("run with a command after -- defaults to scratchpad mode", () => {
    expect(parseCliArgs(["run", "--", "my-agent", "--flag", "x"])).toEqual({
      kind: "run",
      command: ["my-agent", "--flag", "x"],
      mode: "scratchpad",
    })
  })

  test("names a session so several can share a directory", () => {
    expect(parseCliArgs(["run", "--session", "red", "--", "x"])).toEqual({
      kind: "run",
      command: ["x"],
      mode: "scratchpad",
      session: "red",
    })
  })

  test("reads every option and leaves the command's own flags alone", () => {
    expect(
      parseCliArgs([
        "run",
        "--mention",
        "--name",
        "Ops",
        "--config",
        "c.json",
        "--timeout",
        "5000",
        "--",
        "sh",
        "-c",
        "cat --help",
      ])
    ).toEqual({
      kind: "run",
      command: ["sh", "-c", "cat --help"],
      mode: "mention",
      name: "Ops",
      config: "c.json",
      timeoutMs: 5000,
    })
  })

  test("connect takes a base url and a name, and no command", () => {
    expect(parseCliArgs(["connect"])).toEqual({ kind: "connect" })
    expect(parseCliArgs(["connect", "--base-url", "http://localhost:3000", "--name", "Ops"])).toEqual({
      kind: "connect",
      baseUrl: "http://localhost:3000",
      name: "Ops",
    })
    expect(() => parseCliArgs(["connect", "--", "x"])).toThrow("connect takes no command")
    expect(() => parseCliArgs(["connect", "--timeout", "soon"])).toThrow("--timeout does not apply to connect")
    expect(() => parseCliArgs(["connect", "--mention"])).toThrow("--mention does not apply to connect")
    expect(() => parseCliArgs(["connect", "--session", "red"])).toThrow("--session does not apply to connect")
    expect(() => parseCliArgs(["run", "--base-url", "https://x", "--", "cmd"])).toThrow(
      "--base-url does not apply to run"
    )
  })

  test("help and version short-circuit", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" })
    expect(parseCliArgs(["-v"])).toEqual({ kind: "version" })
  })

  test("rejects a missing command, an unknown subcommand, and a bad timeout", () => {
    expect(() => parseCliArgs(["run"])).toThrow("after `--`")
    expect(() => parseCliArgs(["serve", "--", "x"])).toThrow("Unknown command: serve")
    expect(() => parseCliArgs(["run", "--timeout", "soon", "--", "x"])).toThrow("--timeout")
    expect(() => parseCliArgs(["run", "--timeout", "2147483648", "--", "x"])).toThrow("--timeout")
  })
})
