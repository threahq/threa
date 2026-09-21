import { describe, expect, test } from "bun:test"
import { slackPayloadToMarkdown, slackTextToMarkdown, type SlackPayloadResult } from "./slack-translator"

describe("slackTextToMarkdown", () => {
  const cases: Array<[name: string, input: string, expected: string]> = [
    [
      "should rewrite a labelled link when given <url|label>",
      "see <https://ex.com/a|the docs>",
      "see [the docs](https://ex.com/a)",
    ],
    ["should unwrap a bare link when given <url>", "see <https://ex.com/a>", "see https://ex.com/a"],
    ["should rewrite mailto when given a labelled mailto link", "<mailto:a@b.co|a@b.co>", "[a@b.co](mailto:a@b.co)"],
    ["should double the asterisks when given slack bold", "a *bold* word", "a **bold** word"],
    ["should convert to asterisk italics when given slack underscores", "a _soft_ word", "a *soft* word"],
    ["should double the tildes when given slack strikethrough", "a ~gone~ word", "a ~~gone~~ word"],
    ["should combine emphases when given bold and italic together", "*b* and _i_", "**b** and *i*"],
    ["should leave a mid-word underscore alone when given snake_case", "a snake_case_name", "a snake_case_name"],
    ["should leave an unmatched delimiter alone when given a lone asterisk", "2 * 3 = 6", "2 * 3 = 6"],
    ["should translate a broadcast when given <!here>", "<!here> deploy done", "@here deploy done"],
    ["should translate a broadcast when given <!channel>", "<!channel>", "@channel"],
    ["should translate a broadcast when given <!everyone>", "<!everyone>", "@everyone"],
    ["should fall back to the label when given an unknown bang sequence", "<!subteam^S1|@ops>", "@ops"],
    ["should render plain text when given a bare user reference", "hi <@U123>", "hi @U123"],
    ["should render the label when given a labelled user reference", "hi <@U123|ada>", "hi @ada"],
    ["should render plain text when given a bare channel reference", "in <#C123>", "in #C123"],
    ["should render the channel name when given a labelled channel reference", "in <#C123|ops>", "in #ops"],
    ["should unescape entities when given escaped ampersands and brackets", "a &amp; b &lt;c&gt;", "a & b <c>"],
    [
      "should leave delimiters untouched when given a code span",
      "`*not bold*` and *bold*",
      "`*not bold*` and **bold**",
    ],
    [
      "should leave delimiters untouched when given a fenced block",
      "```\n*a* _b_ <https://ex.com>\n```\nafter *c*",
      "```\n*a* _b_ <https://ex.com>\n```\nafter **c**",
    ],
    ["should keep a multi-line body when given newlines", "line one\nline *two*", "line one\nline **two**"],
    ["should return the input unchanged when given plain prose", "nothing to do here", "nothing to do here"],
    [
      "should unescape the entity inside the target when given a link whose url carries &amp;",
      "<https://a.b/c?x=1&amp;y=2|label>",
      "[label](https://a.b/c?x=1&y=2)",
    ],
    ["should escape the bracket when given a link label containing ]", "<https://a.b|a]b>", "[a\\]b](https://a.b)"],
    [
      "should leave the label asterisks alone when given a link label containing *",
      "<https://a.b|2 * 3>",
      "[2 * 3](https://a.b)",
    ],
    [
      "should leave the url underscores alone when given a url with underscore-delimited segments",
      "see <https://a.b/x/_y_/z>",
      "see https://a.b/x/_y_/z",
    ],
    [
      "should escape the parens when given a url containing them",
      "<https://a.b/x(1)|wiki>",
      "[wiki](https://a.b/x\\(1\\))",
    ],
    [
      "should bold across the link when given emphasis wrapping a control sequence",
      "*see <https://a.b|here> now*",
      "**see [here](https://a.b) now**",
    ],
    ["should leave the arithmetic alone when given spaced asterisks", "2 * 3 * 4", "2 * 3 * 4"],
    ["should bold when given a delimiter adjacent to punctuation", "(*bold*), *end*.", "(**bold**), **end**."],
    [
      "should leave a url underscore alone when given snake_case in prose",
      "run job_name_two now",
      "run job_name_two now",
    ],
    ["should render the fallback when given a date control sequence", "<!date^1737^{date}|Sep 21>", "Sep 21"],
    ["should render the group label when given a subteam reference", "<!subteam^S123|@team>", "@team"],
    ["should render the raw name when given an unknown bang sequence with no label", "<!foo>", "foo"],
    ["should unescape entities inside a code span when given slack-escaped code", "`a &amp; b`", "`a & b`"],
    [
      "should keep multiple lines when given a multi-line body with emphasis on each",
      "*one*\n_two_\n~three~",
      "**one**\n*two*\n~~three~~",
    ],
    ["should return an empty string when given an empty string", "", ""],
  ]

  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(slackTextToMarkdown(input)).toBe(expected)
    })
  }
})

describe("slackPayloadToMarkdown", () => {
  test("should return translated markdown when given a payload with text", () => {
    expect(slackPayloadToMarkdown({ text: "*Alert* <https://ex.com/run|run 12>" })).toEqual({
      markdown: "**Alert** [run 12](https://ex.com/run)",
    })
  })

  test("should ignore unknown fields when given a full slack webhook payload", () => {
    expect(slackPayloadToMarkdown({ text: "hi", username: "bot", icon_emoji: ":x:", blocks: [] })).toEqual({
      markdown: "hi",
    })
  })

  type SlackPayloadError = Extract<SlackPayloadResult, { error: string }>["error"]
  const refusals: Array<[name: string, payload: unknown, error: SlackPayloadError]> = [
    ["should refuse with no_text when given an empty object", {}, "no_text"],
    ["should refuse with no_text when given a blank text", { text: "   \n " }, "no_text"],
    ["should refuse with no_text when given a null text", { text: null }, "no_text"],
    ["should refuse with invalid_payload when given a numeric text", { text: 42 }, "invalid_payload"],
    ["should refuse with invalid_payload when given an object text", { text: { a: 1 } }, "invalid_payload"],
    ["should refuse with invalid_payload when given an array", [{ text: "hi" }], "invalid_payload"],
    ["should refuse with invalid_payload when given a string", "hi", "invalid_payload"],
    ["should refuse with invalid_payload when given null", null, "invalid_payload"],
    ["should refuse with invalid_payload when given undefined", undefined, "invalid_payload"],
  ]

  for (const [name, payload, error] of refusals) {
    test(name, () => {
      expect(slackPayloadToMarkdown(payload)).toEqual({ error })
    })
  }
})
