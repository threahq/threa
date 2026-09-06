import { decodeAndSanitizeRedirectState } from "@threahq/backend-common"

/**
 * Peel the optional `add|` multi-account sentinel off the OAuth `state`.
 *
 * `login` prefixes a literal `add|` onto the *plaintext* state when
 * `intent=add`; `getAuthorizationUrl` then base64-encodes the whole thing.
 * Here we decode once, strip the sentinel, and re-encode the inner plaintext
 * so the existing host/path decode logic runs on a byte-identical payload.
 * For the non-add path `innerState` is the original `state` untouched, keeping
 * single-account decoding exactly as it was.
 */
export function parseCallbackState(state: string | undefined): { isAdd: boolean; innerState: string | undefined } {
  if (!state) return { isAdd: false, innerState: state }
  const decoded = Buffer.from(state, "base64").toString("utf-8")
  if (decoded.startsWith("add|")) {
    const inner = decoded.slice("add|".length)
    return { isAdd: true, innerState: Buffer.from(inner, "utf-8").toString("base64") }
  }
  return { isAdd: false, innerState: state }
}

/**
 * Decode the post-auth redirect target encoded in `innerState`.
 *
 * Two forms: the `host|path` forwarded-host form (the `host` is returned so a
 * caller that crosses origins — the WorkOS callback — can build the absolute
 * URL; same-origin callers like the stub login form ignore it) and the bare
 * `path` form. Empty/absent state falls back to "/". `redirectPath` is always
 * sanitized to a safe relative path.
 */
export function splitInnerState(innerState: string | undefined): { host: string | null; redirectPath: string } {
  const decoded = innerState ? Buffer.from(innerState, "base64").toString("utf-8") : ""
  const pipeIndex = decoded.indexOf("|")
  if (pipeIndex !== -1) {
    const host = decoded.substring(0, pipeIndex)
    const redirectPath = decodeAndSanitizeRedirectState(
      Buffer.from(decoded.substring(pipeIndex + 1)).toString("base64")
    )
    return { host, redirectPath }
  }
  return { host: null, redirectPath: innerState ? decodeAndSanitizeRedirectState(innerState) : "/" }
}
