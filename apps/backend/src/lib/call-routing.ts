export const CALLS_NAMESPACE = "/calls"

export function callRoom(callId: string): string {
  return `call:${callId}`
}
