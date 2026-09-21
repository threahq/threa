import { describe, expect, test } from "bun:test"
import { slackPayloadToMarkdown, slackTextToMarkdown, type SlackPayloadResult } from "./slack-translator"
import alertmanager from "./fixtures/alertmanager.json"
import gitlab from "./fixtures/gitlab.json"
import grafana from "./fixtures/grafana.json"
import uptimeKuma from "./fixtures/uptime-kuma.json"

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

describe("slackTextToMarkdown link targets", () => {
  test("should keep only the label when the target is not a web or mail address", () => {
    expect(
      slackTextToMarkdown(
        "<attachment:att_01ABC|leak.pdf> <channel:stream_01ABC|#ops> <user:usr_01ABC> <mailto:a@ex.example.net|mail>"
      )
    ).toBe("leak.pdf #ops user:usr_01ABC [mail](mailto:a@ex.example.net)")
  })
})

describe("slackPayloadToMarkdown attachments and blocks", () => {
  test("should render title, body and footer when given a grafana alert", () => {
    expect(slackPayloadToMarkdown(grafana)).toEqual({
      markdown: [
        "**[\\[FIRING:1\\] HighErrorRate prod api](https://grafana.example.net/alerting/list)**",
        "**Firing**",
        "",
        "Value: B=0.34",
        "Labels:",
        " - alertname = HighErrorRate",
        " - service = api",
        "Annotations:",
        " - summary = error rate above 5% for 10m",
        "Source: https://grafana.example.net/alerting/grafana/ae1q/view",
        "Silence: https://grafana.example.net/alerting/silence/new",
        "Grafana v11.2.0",
      ].join("\n"),
    })
  })

  test("should render pretext, title, text and fields when given an alertmanager alert", () => {
    expect(slackPayloadToMarkdown(alertmanager)).toEqual({
      markdown: [
        "**Alerts firing for** `node-exporter`",
        "**[\\[FIRING:2\\] InstanceDown node-exporter](https://alertmanager.example.net/#/alerts?receiver=slack)**",
        "Instance has been down for more than 5 minutes.",
        "**severity:** critical",
        "**runbook:** [InstanceDown](https://runbooks.example.net/instance-down)",
        "Prometheus Alertmanager",
      ].join("\n"),
    })
  })

  test("should render the blocks inside the attachment when given an uptime kuma notification", () => {
    expect(slackPayloadToMarkdown(uptimeKuma)).toEqual({
      markdown: [
        "Uptime Kuma Alert",
        "",
        "**Uptime Kuma Alert**",
        "",
        "**Message**",
        "[api.example.net] [Down] connect ECONNREFUSED",
        "**Time (UTC)**",
        "2026-09-21 11:04:12",
        "",
        "[Visit Uptime Kuma](https://kuma.example.net)",
      ].join("\n"),
    })
  })

  test("should render pretext and body links when given a gitlab push notification", () => {
    expect(slackPayloadToMarkdown(gitlab)).toEqual({
      markdown: [
        "[acme/api](https://gitlab.example.net/acme/api)",
        "[2 commits](https://gitlab.example.net/acme/api/-/compare/a1b2c3d...e4f5g6h) pushed to [main](https://gitlab.example.net/acme/api/-/tree/main)",
        "",
        "[e4f5g6h](https://gitlab.example.net/acme/api/-/commit/e4f5g6h): cache the stream index - Ada Byron",
      ].join("\n"),
    })
  })

  test("should drop the notification text when given top-level blocks that render", () => {
    expect(
      slackPayloadToMarkdown({
        text: "fallback for notifications",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Deploy &amp; release" } },
          { type: "divider" },
          { type: "section", text: { type: "mrkdwn", text: "*done* in <https://ci.example.net/9|run 9>" } },
          {
            type: "context",
            elements: [
              { type: "image", image_url: "https://ci.example.net/i.png", alt_text: "ci" },
              { type: "mrkdwn", text: "_by_ ada" },
            ],
          },
          { type: "image", image_url: "https://ci.example.net/graph.png", alt_text: "latency graph" },
          {
            type: "actions",
            elements: [
              { type: "button", text: { type: "plain_text", text: "Open" }, url: "https://ci.example.net/9" },
              { type: "button", text: { type: "plain_text", text: "Retry" }, action_id: "retry" },
            ],
          },
          { type: "unknown_block", text: { type: "mrkdwn", text: "ignored" } },
        ],
      })
    ).toEqual({
      markdown: [
        "**Deploy & release**",
        "",
        "---",
        "",
        "**done** in [run 9](https://ci.example.net/9)",
        "",
        "*by* ada",
        "",
        "[latency graph](https://ci.example.net/graph.png)",
        "",
        "[Open](https://ci.example.net/9)",
      ].join("\n"),
    })
  })

  test("should keep the text when given top-level blocks that render nothing", () => {
    expect(slackPayloadToMarkdown({ text: "still here", blocks: [{ type: "unknown_block" }, "nonsense"] })).toEqual({
      markdown: "still here",
    })
  })

  test("should link the author when given an attachment carrying author_name and author_link", () => {
    expect(
      slackPayloadToMarkdown({
        attachments: [{ author_name: "Ada Byron", author_link: "https://gitlab.example.net/ada", text: "pushed" }],
      })
    ).toEqual({ markdown: "[Ada Byron](https://gitlab.example.net/ada)\npushed" })
  })

  test("should keep the author name when given author_name without a link", () => {
    expect(slackPayloadToMarkdown({ attachments: [{ author_name: "Ada Byron" }] })).toEqual({ markdown: "Ada Byron" })
  })

  test("should percent-encode whitespace when given a link target carrying spaces", () => {
    expect(
      slackPayloadToMarkdown({ attachments: [{ title: "report", title_link: "https://x.example/a b(c)" }] })
    ).toEqual({ markdown: "**[report](https://x.example/a%20b\\(c\\))**" })
  })

  test("should collapse newlines when given a link label spanning lines", () => {
    expect(
      slackPayloadToMarkdown({ attachments: [{ title: "line one\nline two", title_link: "https://x.example/a" }] })
    ).toEqual({ markdown: "**[line one line two](https://x.example/a)**" })
  })

  test("should render the fallback when given an attachment carrying nothing else", () => {
    expect(slackPayloadToMarkdown({ attachments: [{ color: "danger", ts: 1, fallback: "*only* fallback" }] })).toEqual({
      markdown: "**only** fallback",
    })
  })

  test("should render lists, code and quotes when given a rich_text block", () => {
    expect(
      slackPayloadToMarkdown({
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "hi", style: { bold: true } },
                  { type: "text", text: " " },
                  { type: "user", user_id: "U123" },
                  { type: "text", text: " " },
                  { type: "broadcast", range: "here" },
                  { type: "text", text: " in " },
                  { type: "channel", channel_id: "C456" },
                  { type: "emoji", name: "wave" },
                  { type: "link", url: "https://ex.example.net/a", text: "docs" },
                ],
              },
              {
                type: "rich_text_list",
                style: "bullet",
                elements: [
                  { type: "rich_text_section", elements: [{ type: "text", text: "first" }] },
                  { type: "rich_text_section", elements: [{ type: "text", text: "second", style: { italic: true } }] },
                ],
              },
              {
                type: "rich_text_list",
                style: "ordered",
                elements: [
                  { type: "rich_text_section", elements: [{ type: "text", text: "one", style: { strike: true } }] },
                  { type: "rich_text_section", elements: [{ type: "text", text: "two", style: { code: true } }] },
                ],
              },
              {
                type: "rich_text_preformatted",
                elements: [{ type: "text", text: "bun test\nbun run lint" }],
              },
              {
                type: "rich_text_quote",
                elements: [{ type: "text", text: "quoted\nover two lines" }],
              },
            ],
          },
        ],
      })
    ).toEqual({
      markdown: [
        "**hi** @U123 @here in #C456:wave:[docs](https://ex.example.net/a)",
        "- first",
        "- *second*",
        "1. ~~one~~",
        "2. `two`",
        "```",
        "bun test",
        "bun run lint",
        "```",
        "> quoted",
        "> over two lines",
      ].join("\n"),
    })
  })

  const garbage: Array<[name: string, payload: unknown]> = [
    ["should refuse without throwing when given non-array attachments", { attachments: { a: 1 } }],
    [
      "should refuse without throwing when given attachment entries that are not objects",
      { attachments: [1, "x", null] },
    ],
    [
      "should refuse without throwing when given wrongly typed attachment fields",
      { attachments: [{ title: 7, text: [], fields: 3, footer: {} }] },
    ],
    [
      "should refuse without throwing when given a field list of scalars",
      { attachments: [{ fields: [1, null, { title: 2, value: 3 }] }] },
    ],
    ["should refuse without throwing when given blocks that are not objects", { blocks: [null, 5, ["x"]] }],
    [
      "should refuse without throwing when given a section with a scalar text object",
      { blocks: [{ type: "section", text: 9, fields: "no" }] },
    ],
    [
      "should refuse without throwing when given a rich_text block of garbage",
      { blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: 4 }, 7] }] },
    ],
    [
      "should refuse without throwing when given an actions block of non-buttons",
      { blocks: [{ type: "actions", elements: [{ type: "button", url: 5 }, null] }] },
    ],
    [
      "should refuse without throwing when given an image block with no url",
      { blocks: [{ type: "image", alt_text: "a" }] },
    ],
  ]

  for (const [name, payload] of garbage) {
    test(name, () => {
      expect(slackPayloadToMarkdown(payload)).toEqual({ error: "no_text" })
    })
  }
})

describe("slackPayloadToMarkdown rich_text list layout", () => {
  const section = (text: string) => ({ type: "rich_text_section", elements: [{ type: "text", text }] })

  test("should indent a nested list and continue numbering when given indent and offset", () => {
    expect(
      slackPayloadToMarkdown({
        blocks: [
          {
            type: "rich_text",
            elements: [
              { type: "rich_text_list", style: "bullet", elements: [section("parent")] },
              { type: "rich_text_list", style: "bullet", indent: 1, elements: [section("child")] },
              { type: "rich_text_list", style: "ordered", offset: 2, elements: [section("three"), section("four")] },
            ],
          },
        ],
      })
    ).toEqual({ markdown: ["- parent", "    - child", "3. three", "4. four"].join("\n") })
  })

  test("should encode every whitespace character when a link target holds a run of them", () => {
    expect(slackPayloadToMarkdown({ text: "<https://ex.example.net/a  b\tc|label>" })).toEqual({
      markdown: "[label](https://ex.example.net/a%20%20b%09c)",
    })
  })

  test("should cap the indent at Slack's maximum when a list claims a deeper one", () => {
    expect(
      slackPayloadToMarkdown({
        blocks: [
          {
            type: "rich_text",
            elements: [{ type: "rich_text_list", style: "bullet", indent: 50_000_000, elements: [section("deep")] }],
          },
        ],
      })
    ).toEqual({ markdown: `${" ".repeat(32)}- deep` })
  })

  test("should render the label alone when an attachment or rich_text link is not a web target", () => {
    expect(
      slackPayloadToMarkdown({
        attachments: [{ title: "leak.pdf", title_link: "attachment:attach_01ABC" }],
        blocks: [
          {
            type: "rich_text",
            elements: [
              { type: "rich_text_section", elements: [{ type: "link", text: "boss", url: "user:usr_01ABC" }] },
            ],
          },
        ],
      })
    ).toEqual({ markdown: "boss\n\n**leak.pdf**" })
  })
})
