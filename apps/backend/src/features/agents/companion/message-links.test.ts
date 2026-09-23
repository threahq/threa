import { describe, expect, test } from "bun:test"
import type { AgentTool } from "@threahq/agent-runtime"
import { parseMarkdown } from "@threahq/prosemirror"
import { AgentToolNames, AuthorTypes, type AuthorType } from "@threahq/types"
import { getAppOrigins } from "../../link-previews"
import type { Message } from "../../messaging"
import { messageLinkCalls } from "./message-links"

const readUrl = { name: AgentToolNames.READ_URL } as AgentTool
const webSearch = { name: AgentToolNames.WEB_SEARCH } as AgentTool
const appLink = `${getAppOrigins()[0]}/w/ws_1`

function message(markdown: string, authorType: AuthorType = AuthorTypes.USER): Message {
  return { authorType, contentMarkdown: markdown, contentJson: parseMarkdown(markdown) } as Message
}

describe("messageLinkCalls", () => {
  test("reads the first two web links in a user's message", () => {
    const calls = messageLinkCalls(
      message(`compare [a](https://a.example/post) with https://b.example/docs and https://c.example/, not ${appLink}`),
      [webSearch, readUrl]
    )

    expect(calls).toEqual([
      { toolName: "read_url", input: { url: "https://a.example/post" } },
      { toolName: "read_url", input: { url: "https://b.example/docs" } },
    ])
  })

  test("opens nothing for a message without web links, a bot's message, or a turn without read_url", () => {
    expect({
      noLinks: messageLinkCalls(message(`what changed in ${appLink}?`), [readUrl]),
      bot: messageLinkCalls(message("see https://a.example/post", AuthorTypes.BOT), [readUrl]),
      noTool: messageLinkCalls(message("see https://a.example/post"), [webSearch]),
      noMessage: messageLinkCalls(null, [readUrl]),
    }).toEqual({ noLinks: undefined, bot: undefined, noTool: undefined, noMessage: undefined })
  })
})
