/**
 * Half B / CF-4 — simulcast / layered-forwarding request shape (answers
 * CLOUDFLARE_API.md Q4, Q5).
 *
 * The plan flags simulcast as decisive for free per-receiver adaptation. This
 * probe creates a session and issues `tracks/new` publish variants carrying
 * candidate simulcast / layer fields to observe WHICH shape CF accepts and what
 * it echoes back per track:
 *   - a plain single-encoding local track (baseline),
 *   - a track declaring `simulcast`/`encodings` layers (the shape RFC / other
 *     SFUs use),
 *   - the documented optional `bidirectionalMediaStream` / `autoDiscover` flags (Q5).
 * It records CF's response `tracks[]` fields + any error codes rather than
 * asserting — the goal is to PIN the accepted contract, not to pass/fail.
 *
 * NOTE: publishing real layers needs a real SDP offer with matching m-lines; a
 * fully faithful probe runs from cf-2's browser peer (which produces real SDP).
 * This script sends structurally-valid-but-medialess offers to capture the API's
 * validation surface; the browser-driven confirmation is cf-2.
 *
 * BLOCKED without a CF dev app — see cf-env.ts.
 */

import { requireCfCreds, makeLiveCf, cfFetch } from "./cf-env"

const MINIMAL_OFFER =
  "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
  "m=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=sendonly\r\na=rtpmap:96 VP8/90000\r\n"

async function main() {
  const creds = requireCfCreds()
  const cf = makeLiveCf(creds)
  console.log("CF-4 simulcast/layer probe — live\n")

  const session = await cf.createSession()
  const sid = session.sessionId
  console.log("session →", sid)

  const variants: Array<{ label: string; body: unknown }> = [
    {
      label: "baseline single-encoding local track",
      body: {
        sessionDescription: { type: "offer", sdp: MINIMAL_OFFER },
        tracks: [{ location: "local", mid: "0", trackName: "probe-video" }],
      },
    },
    {
      label: "local track with simulcast encodings[]",
      body: {
        sessionDescription: { type: "offer", sdp: MINIMAL_OFFER },
        tracks: [
          {
            location: "local",
            mid: "0",
            trackName: "probe-video-sim",
            simulcast: { encodings: [{ rid: "f" }, { rid: "h" }, { rid: "q" }] },
          },
        ],
      },
    },
    {
      label: "documented optional flags (bidirectionalMediaStream / autoDiscover)",
      body: {
        sessionDescription: { type: "offer", sdp: MINIMAL_OFFER },
        bidirectionalMediaStream: true,
        autoDiscover: true,
        tracks: [{ location: "local", mid: "0", trackName: "probe-video-flags" }],
      },
    },
  ]

  for (const v of variants) {
    const res = await cfFetch(creds, "POST", `/sessions/${encodeURIComponent(sid)}/tracks/new`, v.body).catch((e) => ({
      status: -1,
      json: String(e),
    }))
    console.log(`\n[${v.label}] → status ${res.status}\n${JSON.stringify(res.json, null, 2)}`)
  }

  console.log(
    "\nRecord which variant CF accepted (2xx, no per-track errorCode) and the exact\n" +
      "echoed fields into CLOUDFLARE_API.md Q4/Q5. cf-2 confirms with real browser SDP."
  )
}

if (import.meta.main) main()
