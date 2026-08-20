/**
 * `mid:kind:direction` per m-section, in SDP order — the compact shape calls
 * diagnostics log for every publish/pull negotiation. Cross-device SDP bugs (a
 * dropped or reordered m-line, a wrong direction on a pulled track in the SFU's
 * answer) are otherwise invisible: the browser's rejection of a bad answer
 * happens client-side, after the proxy leg already returned 200. Shared by the
 * backend CF proxy logs and the frontend transport's negotiation errors.
 */
export function summarizeSdpMSections(sdp: string | undefined): string {
  if (!sdp) return "none"
  const sections: Array<{ kind: string; mid: string; direction: string }> = []
  let current: { kind: string; mid: string; direction: string } | null = null
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("m=")) {
      current = { kind: line.slice(2).split(" ")[0] ?? "?", mid: "?", direction: "?" }
      sections.push(current)
    } else if (current && line.startsWith("a=mid:")) {
      current.mid = line.slice("a=mid:".length).trim()
    } else if (current && /^a=(sendrecv|sendonly|recvonly|inactive)\s*$/.test(line)) {
      current.direction = line.slice(2).trim()
    }
  }
  if (sections.length === 0) return "none"
  return sections.map((s) => `${s.mid}:${s.kind}:${s.direction}`).join(" ")
}
