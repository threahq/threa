import { HttpError } from "@threahq/backend-common"
import { toShortcode } from "./emoji"

/**
 * `toShortcode` for request input: also accepts a bare name (`thumbsup`, `+1`),
 * and rejects with the 400 every caller shares.
 */
export function requireShortcode(input: string): string {
  const shortcode = toShortcode(input) ?? toShortcode(`:${input.trim()}:`)
  if (!shortcode) throw new HttpError("Invalid emoji", { status: 400, code: "INVALID_EMOJI" })
  return shortcode
}
