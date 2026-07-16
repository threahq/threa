import { createHmac, timingSafeEqual } from "crypto"

const SIGNATURE_PREFIX = "sha256="

/**
 * Verify GitHub's `X-Hub-Signature-256` over the raw request bytes. The compare
 * is constant-time (`timingSafeEqual`) once lengths match; a length mismatch or
 * missing/misformatted header is a fast, non-timing-sensitive reject because it
 * reveals nothing about the secret.
 */
export function verifyGithubSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false
  }
  const expected = SIGNATURE_PREFIX + createHmac("sha256", secret).update(rawBody).digest("hex")
  const received = Buffer.from(signatureHeader)
  const computed = Buffer.from(expected)
  if (received.length !== computed.length) {
    return false
  }
  return timingSafeEqual(received, computed)
}
