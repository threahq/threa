/** What a connector tells its agent to reply to stay silent; the connector then closes the turn with an empty reply. */
export const NO_RESPONSE_SENTINEL = "THREA_NO_RESPONSE"

/** Agents often narrate before choosing silence, so a sentinel on the last line silences the whole reply. */
export function isNoResponse(text: string): boolean {
  return text.trim().split("\n").at(-1)?.trim() === NO_RESPONSE_SENTINEL
}
