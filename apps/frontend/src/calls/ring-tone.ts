// Runtime-synthesized incoming-call ring. No bundled audio asset — a short
// two-tone warble from a WebAudio oscillator pair, gated by a repeating gain
// cadence (ring ~1.5s, silence ~2.5s), which is smaller than any file and needs
// no asset pipeline. Playback requires a resumed AudioContext (browser autoplay
// policy), so a page with no prior user gesture (sticky activation) can't sound;
// callers fall back to a local SW notification for the OS sound in that case.

let ctx: AudioContext | null = null
let ringNodes: { osc1: OscillatorNode; osc2: OscillatorNode; gain: GainNode } | null = null
let cadenceTimer: ReturnType<typeof setInterval> | null = null
let warmupInstalled = false

function createContext(): AudioContext | null {
  if (typeof window === "undefined") return null
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    return new Ctor()
  } catch {
    return null
  }
}

/**
 * Resume (or lazily create) the ring AudioContext from a user gesture. Idempotent
 * — safe to call on every gesture. The context can only leave `suspended` inside
 * a gesture, so this is what makes a later `startRing()` audible.
 */
export function warmRingAudio(): void {
  if (!ctx) ctx = createContext()
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {})
}

/**
 * Install one-time global gesture listeners that warm the ring context, so a
 * ring that arrives later can sound without needing a gesture at ring time.
 * Returns a teardown. Idempotent across mounts.
 */
export function installRingAudioWarmup(): () => void {
  if (warmupInstalled || typeof window === "undefined") return () => {}
  warmupInstalled = true
  const onGesture = () => warmRingAudio()
  window.addEventListener("pointerdown", onGesture, { passive: true })
  window.addEventListener("keydown", onGesture)
  return () => {
    window.removeEventListener("pointerdown", onGesture)
    window.removeEventListener("keydown", onGesture)
    warmupInstalled = false
  }
}

/** Whether a `startRing()` right now would actually be audible (context running). */
export function isRingAudioReady(): boolean {
  return ctx !== null && ctx.state === "running"
}

/**
 * Start the looping ring. Returns true if it is audible; false when no resumed
 * AudioContext exists (no prior gesture) — the caller then relies on the SW
 * notification for the OS sound. Idempotent: a second call is a no-op.
 */
export function startRing(): boolean {
  if (ringNodes) return isRingAudioReady()
  if (!ctx) ctx = createContext()
  if (!ctx || ctx.state !== "running") return false

  const gain = ctx.createGain()
  gain.gain.value = 0
  gain.connect(ctx.destination)

  const osc1 = ctx.createOscillator()
  const osc2 = ctx.createOscillator()
  osc1.type = "sine"
  osc2.type = "sine"
  osc1.frequency.value = 440
  osc2.frequency.value = 480
  osc1.connect(gain)
  osc2.connect(gain)
  osc1.start()
  osc2.start()
  ringNodes = { osc1, osc2, gain }

  const pulse = () => {
    if (!ctx || !ringNodes) return
    const now = ctx.currentTime
    const g = ringNodes.gain.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(0, now)
    g.linearRampToValueAtTime(0.18, now + 0.05)
    g.setValueAtTime(0.18, now + 1.4)
    g.linearRampToValueAtTime(0, now + 1.5)
  }
  pulse()
  cadenceTimer = setInterval(pulse, 4000)
  return true
}

/** Stop the ring and release its nodes. Idempotent. */
export function stopRing(): void {
  if (cadenceTimer) {
    clearInterval(cadenceTimer)
    cadenceTimer = null
  }
  if (ringNodes) {
    try {
      ringNodes.osc1.stop()
      ringNodes.osc2.stop()
      ringNodes.osc1.disconnect()
      ringNodes.osc2.disconnect()
      ringNodes.gain.disconnect()
    } catch {
      // Nodes already stopped/disconnected.
    }
    ringNodes = null
  }
}
