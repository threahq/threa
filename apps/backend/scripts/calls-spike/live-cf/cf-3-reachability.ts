/**
 * Half B / CF-3 — reachability + TLS-443 / TURN fallback (answers CLOUDFLARE_API.md Q6).
 *
 * Enterprise reachability against Cloudflare's anycast is only partly automatable
 * from a script (the decisive test is a real browser behind a strict/enterprise
 * firewall, which is the manual checklist below). What this DOES probe:
 *   - TCP reachability of the CF Realtime API host on 443,
 *   - reachability of CF's anycast STUN (stun.cloudflare.com) on 3478 TCP and the
 *     TURN-over-TLS 443 path (`turn.cloudflare.com:443`),
 *   - that the authenticated API answers (createSession round-trip), which is the
 *     signaling-plane reachability the media plane depends on.
 * ICE/TURN candidate gathering and the actual TLS-443 media fallback are exercised
 * by cf-2's browser peers (getStats / candidate types); the manual matrix covers
 * strict-NAT / enterprise egress that no lab machine here reproduces.
 *
 * BLOCKED without a CF dev app for the API round-trip — see cf-env.ts. The raw TCP
 * probes still print (they need no creds) so partial reachability is visible.
 */

import * as net from "net"
import { requireCfCreds, makeLiveCf } from "./cf-env"

async function tcpProbe(
  host: string,
  port: number,
  timeoutMs = 4000
): Promise<{ host: string; port: number; open: boolean; ms: number }> {
  const start = Date.now()
  return new Promise((resolve) => {
    const sock = new net.Socket()
    sock.setTimeout(timeoutMs)
    const done = (open: boolean) => {
      sock.destroy()
      resolve({ host, port, open, ms: Date.now() - start })
    }
    sock.once("connect", () => done(true))
    sock.once("timeout", () => done(false))
    sock.once("error", () => done(false))
    sock.connect(port, host)
  })
}

const MANUAL_MATRIX = `
Manual reachability matrix (no lab machine reproduces these — run on the real network):
  [ ] Corporate / enterprise egress allowing only TLS-443 outbound: call connects via
      CF integrated TURN over 443 (getStats: candidate type 'relay', protocol tls).
  [ ] Symmetric / strict NAT (double-NAT home + carrier CGNAT): outward-to-CF anycast
      connects without our own TURN infra.
  [ ] Network handoff (Wi-Fi → cellular mid-call): ICE restart / session recovery within
      the lease; roster shows reconnecting → connected, no reap.
  [ ] Safari desktop + iOS Safari: single getUserMedia capture, suspended AudioContext
      resume on gesture, no PiP.
  [ ] Packet loss 5–10% (link conditioner): publisher watchdog steps the published layer
      down; per-receiver adaptation holds the call.
`

async function main() {
  console.log("CF-3 reachability — live probe\n")

  // Creds-free TCP probes first, so partial reachability is visible even with no CF
  // dev app (the signaling round-trip below still fails fast without creds).
  const probes = await Promise.all([
    tcpProbe("rtc.live.cloudflare.com", 443),
    tcpProbe("stun.cloudflare.com", 3478),
    tcpProbe("turn.cloudflare.com", 443),
    tcpProbe("turn.cloudflare.com", 3478),
  ])
  for (const p of probes) console.log(`  ${p.open ? "reachable" : "UNREACHABLE"}  ${p.host}:${p.port} (${p.ms}ms)`)

  const creds = requireCfCreds() // signaling round-trip needs the dev app
  const cf = makeLiveCf(creds)
  try {
    const s = await cf.createSession()
    console.log(`\n  signaling round-trip OK → session ${s.sessionId}`)
  } catch (err) {
    console.log(`\n  signaling round-trip FAILED → ${err instanceof Error ? err.message : String(err)}`)
  }

  console.log(MANUAL_MATRIX)
}

if (import.meta.main) main()
