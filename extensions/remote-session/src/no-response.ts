/** What a connector tells its agent to reply to stay silent; the connector then closes the turn with an empty reply. */
export const NO_RESPONSE_SENTINEL = "THREA_NO_RESPONSE"

export function isNoResponse(text: string): boolean {
  return text.trim() === NO_RESPONSE_SENTINEL
}
