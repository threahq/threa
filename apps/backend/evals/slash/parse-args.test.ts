import { describe, it, expect } from "bun:test"
import { parseEvalCommand, EvalCommandError, DEFAULT_SUITE } from "./parse-args"

describe("parseEvalCommand", () => {
  it("defaults to the boundary-extraction suite when none is named", () => {
    expect(parseEvalCommand("/eval")).toEqual({
      args: ["-s", DEFAULT_SUITE],
      echo: `/eval -s ${DEFAULT_SUITE}`,
    })
  })

  it("passes through all supported flags in canonical order", () => {
    const parsed = parseEvalCommand(
      "/eval -s memo-classifier -c a-1,b_2 -m openrouter:openai/gpt-5.4-mini -r 6 -p 4 -t 0.2 --min-pass-rate 0.8"
    )
    expect(parsed.args).toEqual([
      "-s",
      "memo-classifier",
      "-c",
      "a-1,b_2",
      "-m",
      "openrouter:openai/gpt-5.4-mini",
      "-r",
      "6",
      "-p",
      "4",
      "-t",
      "0.2",
      "--min-pass-rate",
      "0.8",
    ])
  })

  it("accepts long-form flags and ignores lines after the first", () => {
    const parsed = parseEvalCommand("/eval --suite stream-naming --runs 3\nplease and thanks")
    expect(parsed.args).toEqual(["-s", "stream-naming", "-r", "3"])
  })

  it("normalizes a comma-separated model list within the cap", () => {
    const parsed = parseEvalCommand("/eval -m openrouter:openai/gpt-5.4-mini,openrouter:openai/gpt-5.4-nano")
    expect(parsed.args).toEqual([
      "-s",
      DEFAULT_SUITE,
      "-m",
      "openrouter:openai/gpt-5.4-mini,openrouter:openai/gpt-5.4-nano",
    ])
  })

  it("rejects a list with spaces after commas (whitespace truncates it)", () => {
    expect(() => parseEvalCommand("/eval -m openrouter:a/b, openrouter:c/d")).toThrow(/no spaces/)
  })

  it("rejects a body that does not start with /eval", () => {
    expect(() => parseEvalCommand("/evaluate now")).toThrow(EvalCommandError)
    expect(() => parseEvalCommand("hello")).toThrow(EvalCommandError)
  })

  it("rejects an unknown suite", () => {
    expect(() => parseEvalCommand("/eval -s not-a-suite")).toThrow(/Unknown suite/)
  })

  it("accepts the brief-correction suite", () => {
    expect(parseEvalCommand("/eval -s brief-correction").args).toEqual(["-s", "brief-correction"])
  })

  it("rejects an unknown flag rather than silently dropping it", () => {
    expect(() => parseEvalCommand("/eval --danger rm")).toThrow(/Unknown argument/)
  })

  it("rejects shell-injection characters in values", () => {
    expect(() => parseEvalCommand("/eval -c a;rm-rf")).toThrow(EvalCommandError)
    expect(() => parseEvalCommand("/eval -m evil$(whoami)")).toThrow(EvalCommandError)
    expect(() => parseEvalCommand("/eval -c `id`")).toThrow(EvalCommandError)
  })

  it("enforces the model-count cap", () => {
    expect(() => parseEvalCommand("/eval -m a:b,c:d,e:f,g:h,i:j")).toThrow(/At most/)
  })

  it("enforces numeric bounds", () => {
    expect(() => parseEvalCommand("/eval -r 99")).toThrow(/between 1 and 12/)
    expect(() => parseEvalCommand("/eval -r 0")).toThrow(/between 1 and 12/)
    expect(() => parseEvalCommand("/eval -p 100")).toThrow(/between 1 and 8/)
    expect(() => parseEvalCommand("/eval -t 2")).toThrow(/between 0.0 and 1.0/)
    expect(() => parseEvalCommand("/eval --min-pass-rate 5")).toThrow(/between 0.0 and 1.0/)
  })

  it("rejects a flag with a missing value", () => {
    expect(() => parseEvalCommand("/eval -s")).toThrow(/requires a value/)
    expect(() => parseEvalCommand("/eval -s -r 3")).toThrow(/requires a value/)
  })
})
