import { describe, expect, it } from "bun:test"
import { parseReactDirectives } from "./react-directives"

describe("parseReactDirectives", () => {
  it("strips directives and returns them in order", () => {
    expect(
      parseReactDirectives(
        [
          "Done.",
          "THREA_REACT: msg_1 :tada:",
          "  THREA_REACT: msg_1 👍",
          "THREA_UNREACT: msg_2 :eyes:",
          "THREA_UNREACT: msg_2 :x:",
        ].join("\n")
      )
    ).toEqual({
      text: "Done.",
      reactions: [
        { emoji: ":tada:", messageId: "msg_1" },
        { emoji: "👍", messageId: "msg_1" },
        { emoji: ":eyes:", messageId: "msg_2", remove: true },
        { emoji: ":x:", messageId: "msg_2", remove: true },
      ],
    })
  })

  it("collapses the blank run a directive leaves behind", () => {
    expect(parseReactDirectives("a\n\nTHREA_REACT: msg_1 :ok:\n\nb").text).toBe("a\n\nb")
  })

  it("leaves directives inside code fences alone", () => {
    const text = "```\nTHREA_REACT: :ok:\n```\n~~~\nTHREA_REACT: :ok:\n~~~"
    expect(parseReactDirectives(text)).toEqual({ text, reactions: [] })
  })

  it("keeps a line that names no message id and single emoji as text", () => {
    const text = "THREA_REACT: is how you react\nTHREA_REACT: msg_1\nTHREA_UNREACT: msg_1 :x: :y:\nTHREA_REACT: :tada:"
    expect(parseReactDirectives(text)).toEqual({ text, reactions: [] })
  })

  it("returns text untouched when there is nothing to strip", () => {
    expect(parseReactDirectives("  hi  \n")).toEqual({ text: "  hi  \n", reactions: [] })
  })

  it("ignores an empty directive", () => {
    expect(parseReactDirectives("THREA_REACT:")).toEqual({ text: "THREA_REACT:", reactions: [] })
  })

  it("keeps blank runs and indentation inside code and elsewhere when it strips a directive", () => {
    const text = "Intro\n\n```py\ndef f():\n\n\n\n    return 1\n```\n    indented\nTHREA_REACT: msg_1 :ok:"
    expect(parseReactDirectives(text).text).toBe("Intro\n\n```py\ndef f():\n\n\n\n    return 1\n```\n    indented")
  })

  it("keeps the leading indentation of the first line it keeps", () => {
    expect(parseReactDirectives("THREA_REACT: msg_1 :ok:\n\n    code").text).toBe("    code")
  })

  it("closes a fence only on the same character, at least as long, without an info string", () => {
    const text = [
      "````md",
      "```",
      "THREA_REACT: :a:",
      "```js",
      "~~~~",
      "THREA_REACT: :b:",
      "````",
      "THREA_REACT: msg_1 :c:",
    ].join("\n")
    expect(parseReactDirectives(text)).toEqual({
      text: ["````md", "```", "THREA_REACT: :a:", "```js", "~~~~", "THREA_REACT: :b:", "````"].join("\n"),
      reactions: [{ emoji: ":c:", messageId: "msg_1" }],
    })
  })

  it("does not read a line indented four spaces as a directive", () => {
    const text = "    THREA_REACT: msg_1 :ok:"
    expect(parseReactDirectives(text)).toEqual({ text, reactions: [] })
  })
})
