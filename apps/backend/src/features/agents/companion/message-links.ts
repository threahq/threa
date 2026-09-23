import type { AgentTool } from "@threahq/agent-runtime"
import { AgentToolNames, AuthorTypes } from "@threahq/types"
import { extractUrls, getAppOrigins } from "../../link-previews"
import type { Message } from "../../messaging"

// A message that links more than two pages is usually a list to pick from, not
// two pages to read before answering.
const OPENED_LINKS = 2

/**
 * `read_url` calls for the web links in a user's message, so the turn starts
 * with the pages it asks about. Links into the app are not web pages and stay
 * with the tools that read workspace content.
 */
export function messageLinkCalls(
  message: Message | null,
  tools: AgentTool[]
): Array<{ toolName: string; input: { url: string } }> | undefined {
  if (message?.authorType !== AuthorTypes.USER) return undefined
  if (!tools.some((tool) => tool.name === AgentToolNames.READ_URL)) return undefined
  const appOrigins = getAppOrigins()
  const urls = extractUrls(message.contentMarkdown, appOrigins, message.contentJson)
    .filter((url) => !appOrigins.includes(new URL(url).origin))
    .slice(0, OPENED_LINKS)
  return urls.length > 0 ? urls.map((url) => ({ toolName: AgentToolNames.READ_URL, input: { url } })) : undefined
}
