import { describe, expect, test } from "bun:test"
import { composeOutputValidator, findInternalSyntax } from "./output-guard"

describe("findInternalSyntax", () => {
  test("rejects a leading msg pointer tag", () => {
    expect(findInternalSyntax("[msg:msg_01KYCCZYDQQNMR18Q5VRTGX0C4 author:persona_system_ariadne] Hi")).toContain(
      "input-only"
    )
  })

  test("rejects a leading msg pointer tag on a longer reply", () => {
    expect(
      findInternalSyntax(
        "[msg:msg_01KYDDWNJ13KRK99YRJ13JRVK author:persona_system_ariadne] Something did seem off there — let me look again."
      )
    ).toContain("input-only")
  })

  test("rejects tool-call markup", () => {
    const content = `<invoke name="workspace_research">
<parameter name="query">preview buggy lazy loading</parameter>
</invoke>`
    expect(findInternalSyntax(content)).toContain("tool-call markup")
  })

  test("rejects a markdown link targeting a tool name", () => {
    expect(
      findInternalSyntax("Handover's up: [message-share preview bug](delegate_task)", {
        toolNames: ["delegate_task", "send_message"],
      })
    ).toContain("delegate_task")
  })

  test("passes a message that discusses pointer tags mid-sentence", () => {
    const content =
      "Those `[msg:msg_… author:…]` tags aren't something I'm meant to output — they're metadata the system stamps onto each message in my context so I can reference/quote things structurally (that's what powers the forwarding/quoting feature). They show up prefixing messages in what I *see*, including my own prior replies."
    expect(findInternalSyntax(content, { toolNames: ["delegate_task"] })).toBeNull()
  })

  test("passes legitimate pointer links", () => {
    const content =
      "Here's the screenshot: [Image #1](attachment:attach_01K…) and [Pierre](quote:stream_x/msg_y/usr_z/user) plus [a memo](memo:memo_01K…)"
    expect(findInternalSyntax(content, { toolNames: ["delegate_task"] })).toBeNull()
  })

  test("passes tool-call markup inside a fenced code block", () => {
    const content = `Here's what it looked like:

\`\`\`
<invoke name="workspace_research">
<parameter name="query">preview buggy lazy loading</parameter>
</invoke>
\`\`\`

That shouldn't have been sent.`
    expect(findInternalSyntax(content)).toBeNull()
  })

  test("rule 3 is opt-in", () => {
    expect(findInternalSyntax("Handover's up: [message-share preview bug](delegate_task)")).toBeNull()
    expect(
      findInternalSyntax("Handover's up: [message-share preview bug](delegate_task)", { toolNames: [] })
    ).toBeNull()
  })

  test("passes prose containing 'parameter' and an angle-bracket comparison", () => {
    expect(findInternalSyntax("The parameter is off: we need a < b for the invoke to make sense.")).toBeNull()
  })
})

describe("findInternalSyntax code-quoting forms", () => {
  const sample = '<invoke name="workspace_research">\n<parameter name="query">preview bugs</parameter>\n</invoke>'

  test("accepts a four-backtick fence wrapping an inner triple-backtick block", () => {
    expect(findInternalSyntax("Like this:\n\n````markdown\n```\n" + sample + "\n```\n````\n")).toBeNull()
  })

  test("accepts a tilde fence", () => {
    expect(findInternalSyntax("Like this:\n\n~~~\n" + sample + "\n~~~\n")).toBeNull()
  })

  test("accepts a four-space indented code block", () => {
    const indented = sample
      .split("\n")
      .map((line) => "    " + line)
      .join("\n")
    expect(findInternalSyntax("Like this:\n\n" + indented + "\n")).toBeNull()
  })

  test("accepts an unclosed fence, which swallows to the end", () => {
    expect(findInternalSyntax("Like this:\n\n```\n" + sample)).toBeNull()
  })

  test("still rejects the markup quoted only in a blockquote", () => {
    expect(findInternalSyntax("> " + sample.split("\n")[0]!)).toContain("fenced code block")
  })

  test("does not let a stray unpaired backtick pair across the markup", () => {
    expect(findInternalSyntax('The `x` op, a stray ` here, then <invoke name="y"> and `code`.')).toContain("<invoke")
  })

  test("names the fenced-code escape hatch in the tool-markup reason", () => {
    const reason = findInternalSyntax(sample)
    expect(reason).toContain("never written into a message")
    expect(reason).toContain("fenced code block")
  })
})

describe("composeOutputValidator", () => {
  test("runs the built-in guard first, then the caller's validator, then passes", async () => {
    const next = (content: string) => (content === "summary" ? "not a summary" : null)
    const validate = composeOutputValidator(["delegate_task"], next)

    expect(await validate("[msg:msg_1 author:persona_x] Hi")).toContain("input-only")
    expect(await validate("See [x](delegate_task)")).toContain("delegate_task")
    expect(await validate("summary")).toBe("not a summary")
    expect(await validate("All good.")).toBeNull()
  })

  test("passes clean content when no next validator is given", async () => {
    expect(await composeOutputValidator([])("All good.")).toBeNull()
  })
})
