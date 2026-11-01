/** What a connector tells its agent to reply to stay silent; the connector then closes the turn with an empty reply. */
export const NO_RESPONSE_SENTINEL = "THREA_NO_RESPONSE"

const TRAILING_SENTINEL = new RegExp(`(^|\\n)[ \\t]*${NO_RESPONSE_SENTINEL}\\s*$`)

export function isNoResponse(text: string): boolean {
  return text.trim() === NO_RESPONSE_SENTINEL
}

/** The agent ended with the sentinel, whatever it wrote before it. */
export function endsWithNoResponse(text: string): boolean {
  return TRAILING_SENTINEL.test(text)
}

/** `text` without a sentinel on its last line, so a stray one never reaches the reader. */
export function withoutNoResponse(text: string): string {
  return text.replace(TRAILING_SENTINEL, "")
}
