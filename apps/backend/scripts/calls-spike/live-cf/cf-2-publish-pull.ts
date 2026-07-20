/**
 * Half B / CF-2 — real two-peer publish/pull through OUR proxy against the REAL
 * Cloudflare SFU (answers CLOUDFLARE_API.md Q2, Q3, and confirms Q4 with real SDP).
 *
 * Flow:
 *   1. Boot ONE backend instance wired to the real CF app (harness.startInstance
 *      with `cf`), seed a workspace + public channel + 2 users, start a call.
 *   2. For each user: join the `/calls` socket to mint a leased endpoint +
 *      incarnation (server-side), then drive a headless Chromium peer (Playwright,
 *      `--use-fake-device-for-media-stream`) that talks to the proxy REST endpoints
 *      same-origin (session cookie set via addCookies):
 *        publisher: getUserMedia(fake) → createEndpointCfSession → publish tracks
 *                   (POST cf/tracks/publish) → setRemoteDescription(answer).
 *        puller:    createEndpointCfSession → pull the publisher's trackNames
 *                   (POST cf/tracks/pull) → setRemoteDescription(offer) →
 *                   createAnswer → POST cf/renegotiate(answer).
 *   3. Assert MEDIA ACTUALLY FLOWS: publisher getStats outbound bytesSent > 0 and
 *      puller getStats inbound bytesReceived > 0 (both directions for a 2-way call).
 *   4. Record the exact publish/pull response contract (requiresImmediateRenegotiation,
 *      answer-SDP presence, per-track error fields, mid vs trackName ownership).
 *
 * BLOCKED without a CF dev app — see cf-env.ts. The renegotiation ordering here
 * encodes cloudflare.ts's DOCUMENTED contract; CONFIRMING it against the live API
 * (and correcting cloudflare.ts if it differs) is precisely this script's job.
 */

import { requireCfCreds } from "./cf-env"
import {
  preflight,
  makePool,
  ensureMigrations,
  startFakeCfServer,
  startInstance,
  makeCallService,
  seedChannel,
  cleanupWorkspace,
  endpointRow,
  CallSocket,
} from "../harness"

// ── in-page WebRTC (runs inside each headless Chromium peer) ─────────────────
// Serialized to the browser via page.evaluate. Talks to the proxy same-origin.
const PEER_SCRIPT = `
async (cfg) => {
  const log = [];
  const api = (path, body) => fetch(path, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

  const base = '/api/workspaces/' + cfg.workspaceId + '/calls/' + cfg.callId + '/endpoints/' + cfg.endpointId;
  const pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
  const iceDone = () => new Promise(res => {
    if (pc.iceGatheringState === 'complete') return res();
    pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res());
  });

  // Create the CF session for this endpoint.
  const session = await api(base + '/cf/session', { mediaIncarnation: cfg.incarnation });
  log.push(['session', session.status]);

  if (cfg.role === 'publisher') {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const tracks = [];
    stream.getTracks().forEach((t, i) => {
      const tr = pc.addTransceiver(t, { direction: 'sendonly' });
      tracks.push({ kind: t.kind === 'audio' ? 'mic' : 'camera', track: t, transceiver: tr });
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await iceDone();
    const publishTracks = tracks.map(t => ({
      kind: t.kind, mid: t.transceiver.mid, trackName: cfg.userId + '-' + t.kind,
    }));
    const pub = await api(base + '/cf/tracks/publish', {
      mediaIncarnation: cfg.incarnation,
      sdp: { type: 'offer', sdp: pc.localDescription.sdp },
      tracks: publishTracks,
    });
    log.push(['publish', pub.status, JSON.stringify(pub.json && { rin: pub.json.requiresImmediateRenegotiation, hasAnswer: !!pub.json.sessionDescription, tracks: pub.json.tracks })]);
    if (pub.json && pub.json.sessionDescription) {
      await pc.setRemoteDescription(pub.json.sessionDescription);
    }
    window.__publishedTrackNames = publishTracks.map(t => t.trackName);
  } else {
    // Puller: pull the publisher's advertised trackNames.
    const pull = await api(base + '/cf/tracks/pull', {
      mediaIncarnation: cfg.incarnation,
      tracks: cfg.pullTracks, // [{ sessionId, trackName }]
    });
    log.push(['pull', pull.status, JSON.stringify(pull.json && { rin: pull.json.requiresImmediateRenegotiation, hasOffer: !!pull.json.sessionDescription })]);
    if (pull.json && pull.json.sessionDescription) {
      await pc.setRemoteDescription(pull.json.sessionDescription);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await iceDone();
      const reneg = await api(base + '/cf/renegotiate', {
        mediaIncarnation: cfg.incarnation,
        sdp: { type: 'answer', sdp: pc.localDescription.sdp },
      });
      log.push(['renegotiate', reneg.status]);
    }
  }

  // Let media flow, then read getStats.
  await new Promise(r => setTimeout(r, 5000));
  let bytesSent = 0, bytesReceived = 0, candidateTypes = new Set();
  const stats = await pc.getStats();
  stats.forEach(s => {
    if (s.type === 'outbound-rtp') bytesSent += s.bytesSent || 0;
    if (s.type === 'inbound-rtp') bytesReceived += s.bytesReceived || 0;
    if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.localCandidateId) candidateTypes.add(s.nominated ? 'nominated' : 'ok');
    if (s.type === 'local-candidate') candidateTypes.add(s.candidateType + '/' + (s.protocol || '?'));
  });
  return { log, bytesSent, bytesReceived, candidateTypes: [...candidateTypes], iceConnectionState: pc.iceConnectionState };
}
`

async function main() {
  const creds = requireCfCreds() // fail fast when the dev app is absent
  await preflight()

  const { chromium } = await import("@playwright/test")
  const pool = makePool()
  await ensureMigrations(pool)
  // Fake server only to satisfy harness signatures for the pool-side CallService;
  // the BACKEND instance is wired to the REAL CF app below.
  const fake = startFakeCfServer()
  const svc = makeCallService(pool, fake.url)

  let wsId = ""
  const cleanup: Array<() => Promise<void> | void> = []
  try {
    const inst = await startInstance({ label: "cf2", fakeCfBase: fake.url, cf: creds })
    cleanup.push(() => inst.stop())

    const ctx = await seedChannel(pool, 2, "cf2")
    wsId = ctx.workspaceId
    const [pub, sub] = ctx.users
    const start = await svc.startCall({ workspaceId: wsId, streamId: ctx.streamId, userId: pub.id, mode: "video" })
    const callId = start.call.id

    // Server-side socket joins mint each peer's endpoint + incarnation.
    const pubInc = "cf2-pub"
    const subInc = "cf2-sub"
    const pubSock = new CallSocket(inst.url, pub.cookie, "pub")
    const subSock = new CallSocket(inst.url, sub.cookie, "sub")
    cleanup.push(
      () => pubSock.disconnect(),
      () => subSock.disconnect()
    )
    await pubSock.connect()
    await subSock.connect()
    const pubJoin = await pubSock.join({ workspaceId: wsId, callId, mediaIncarnation: pubInc })
    const subJoin = await subSock.join({ workspaceId: wsId, callId, mediaIncarnation: subInc })

    const iceServers = [{ urls: "stun:stun.cloudflare.com:3478" }]
    const browser = await chromium.launch({
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    })
    cleanup.push(() => browser.close())

    const openPeer = async (cookieUser: string) => {
      const context = await browser.newContext()
      await context.addCookies([{ name: "wos_session_test", value: `test_session_${cookieUser}`, url: inst.url }])
      const page = await context.newPage()
      await page.goto(`${inst.url}/health`)
      return page
    }

    interface PeerResult {
      log: unknown[]
      bytesSent: number
      bytesReceived: number
      candidateTypes: string[]
      iceConnectionState: string
    }

    // Publisher first (its trackNames must exist before the puller pulls).
    const pubPage = await openPeer(pub.workosUserId)
    const pubResult = (await pubPage.evaluate(PEER_SCRIPT as unknown as string, {
      role: "publisher",
      workspaceId: wsId,
      callId,
      endpointId: pubJoin.data!.endpointId,
      incarnation: pubInc,
      userId: pub.id,
      iceServers,
    })) as PeerResult
    const publishedTrackNames = await pubPage.evaluate("window.__publishedTrackNames")

    // The puller must reference the publisher's REAL CF session id (Q3): CF pull is
    // {sessionId: <publisher's CF session>, trackName}. The publisher's PEER_SCRIPT
    // created its CF session via POST cf/session, which persisted cf_session_id on the
    // publisher endpoint row — resolve it now and inject it below.
    const pubEp = await endpointRow(pool, pubJoin.data!.endpointId)
    const publisherCfSessionId = pubEp?.cf_session_id
    if (!publisherCfSessionId) {
      throw new Error(
        `publisher endpoint ${pubJoin.data!.endpointId} has no cf_session_id — CF session was not created; cannot pull`
      )
    }

    const subPage = await openPeer(sub.workosUserId)
    const subResult = (await subPage.evaluate(PEER_SCRIPT as unknown as string, {
      role: "puller",
      workspaceId: wsId,
      callId,
      endpointId: subJoin.data!.endpointId,
      incarnation: subInc,
      userId: sub.id,
      iceServers,
      pullTracks: (publishedTrackNames as string[]).map((trackName) => ({
        sessionId: publisherCfSessionId,
        trackName,
      })),
    })) as PeerResult

    console.log("CF-2 publisher →", JSON.stringify(pubResult, null, 2))
    console.log("CF-2 puller →", JSON.stringify(subResult, null, 2))
    const pass = pubResult.bytesSent > 0 && subResult.bytesReceived > 0
    console.log(
      `\nMEDIA FLOW ${pass ? "CONFIRMED" : "NOT CONFIRMED"} — publisher bytesSent=${pubResult.bytesSent}, puller bytesReceived=${subResult.bytesReceived}`
    )
    console.log(
      "Record into CLOUDFLARE_API.md: the publish/pull response contract in the logs above\n" +
        "(requiresImmediateRenegotiation, answer/offer SDP presence, per-track error fields).\n" +
        `Q3 pull body used the publisher's resolved CF session id (${publisherCfSessionId}).`
    )
    process.exit(pass ? 0 : 1)
  } finally {
    for (const fn of cleanup.reverse()) await fn()
    if (wsId) await cleanupWorkspace(pool, wsId).catch(() => {})
    fake.stop()
    await pool.end()
  }
}

if (import.meta.main) main()
