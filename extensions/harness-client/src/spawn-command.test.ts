import { describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { parseSpawnCommandArgs, writeSpawnBrief } from "./spawn-command"

const USAGE =
  "Usage: `/spawn [claude|pi] [--model <model>] [--thinking <level>] <name>` with the prompt on the following lines."
const CLAUDE_LEVELS = ["low", "medium", "high", "xhigh", "max"]
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
const BOTH = [
  { value: "claude", label: "Claude Code", installed: true, thinkingLevels: CLAUDE_LEVELS },
  { value: "pi", label: "Pi", installed: true, thinkingLevels: PI_LEVELS },
]
const PI_ONLY = [
  { value: "claude", label: "Claude Code", installed: false, thinkingLevels: CLAUDE_LEVELS },
  { value: "pi", label: "Pi", installed: true, thinkingLevels: PI_LEVELS },
]
const parse = (args: string, runtimes = BOTH, defaultRuntime = "claude") =>
  parseSpawnCommandArgs(args, { runtimes, defaultRuntime })

describe("parseSpawnCommandArgs", () => {
  it("takes a leading runtime token, the rest of the line as the name and the rest as the prompt", () => {
    expect(parse("pi fix sidebar\nDo X\nthen Y")).toEqual({
      runtime: "pi",
      name: "fix sidebar",
      prompt: "Do X\nthen Y",
    })
  })

  it("reads CRLF input the same as LF", () => {
    expect(parse("pi fix sidebar\r\nDo X\r\nthen Y")).toEqual({
      runtime: "pi",
      name: "fix sidebar",
      prompt: "Do X\nthen Y",
    })
  })

  it("falls back to the default runtime when the first token is a name", () => {
    expect(parse("fix sidebar")).toEqual({ runtime: "claude", name: "fix sidebar", prompt: "" })
  })

  it("rejects a missing name, runtime token or not", () => {
    expect(parse("")).toEqual({ error: USAGE })
    expect(parse("pi")).toEqual({ error: USAGE })
    expect(parse("  \nDo X")).toEqual({ error: USAGE })
    expect(parse("claude --model opus")).toEqual({ error: USAGE })
  })

  it("rejects a name token that would reach harnessd as a flag", () => {
    expect(parse("claude --force fix sidebar")).toEqual({ error: USAGE })
  })

  it("refuses a runtime harnessd knows but this machine lacks instead of folding it into the name", () => {
    expect(parse("claude fix", PI_ONLY, "pi")).toEqual({
      error: "`claude` is not installed on this machine. Installed: pi.",
    })
  })

  it("refuses the default runtime when it is the one missing", () => {
    expect(parse("fix sidebar", PI_ONLY, "claude")).toEqual({
      error: "`claude` is not installed on this machine. Installed: pi.",
    })
  })

  it("treats a first token no runtime is called as the name", () => {
    expect(parse("codex fix", PI_ONLY, "pi")).toEqual({ runtime: "pi", name: "codex fix", prompt: "" })
  })

  it("lists only the installed runtimes in the usage line", () => {
    expect(parse("", PI_ONLY, "pi")).toEqual({
      error:
        "Usage: `/spawn [pi] [--model <model>] [--thinking <level>] <name>` with the prompt on the following lines.",
    })
  })

  it("names the missing default without a list when nothing is installed", () => {
    expect(parse("fix", [], "claude")).toEqual({ error: "`claude` is not installed on this machine." })
  })

  it("reads the model and thinking flags wherever they sit on the first line", () => {
    expect(parse("claude --model opus fix sidebar --thinking HIGH\nDo X")).toEqual({
      runtime: "claude",
      name: "fix sidebar",
      prompt: "Do X",
      model: "opus",
      thinking: "high",
    })
  })

  it("keeps a pi model pattern, provider and thinking suffix intact", () => {
    expect(parse("pi --model openai-codex/gpt-5.6-sol explore perf")).toEqual({
      runtime: "pi",
      name: "explore perf",
      prompt: "",
      model: "openai-codex/gpt-5.6-sol",
    })
  })

  it("rejects a flag with no value", () => {
    expect(parse("claude --model --thinking high name")).toEqual({
      error: `\`--model\` needs a value. ${USAGE}`,
    })
    expect(parse("claude fix sidebar --thinking")).toEqual({
      error: `\`--thinking\` needs a value. ${USAGE}`,
    })
  })

  it("validates the thinking level against the spawned runtime, not the caller's", () => {
    expect(parse("pi --thinking minimal explore perf")).toEqual({
      runtime: "pi",
      name: "explore perf",
      prompt: "",
      thinking: "minimal",
    })
    // `minimal` is a pi level and `ultracode` a Claude TUI-only /effort step; neither reaches `claude --effort`.
    expect(parse("claude --thinking minimal fix sidebar", BOTH, "pi")).toEqual({
      error: "`claude` takes `--thinking` low, medium, high, xhigh, max; set anything else in the session.",
    })
    expect(parse("claude --thinking ultracode fix sidebar")).toEqual({
      error: "`claude` takes `--thinking` low, medium, high, xhigh, max; set anything else in the session.",
    })
  })
})

describe("writeSpawnBrief", () => {
  it("writes the prompt to a private file directly under the base directory, creating no directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-brief-test-"))
    const path = writeSpawnBrief("Do X\nthen Y", { dir })

    expect({
      content: readFileSync(path, "utf8"),
      mode: statSync(path).mode & 0o777,
      parent: dirname(path),
      entries: readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      })),
    }).toEqual({
      content: "Do X\nthen Y",
      mode: 0o600,
      parent: dir,
      entries: [{ name: basename(path), directory: false }],
    })
  })

  it("never reuses a path between calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-brief-test-"))
    expect(writeSpawnBrief("first", { dir })).not.toBe(writeSpawnBrief("second", { dir }))
  })
})
