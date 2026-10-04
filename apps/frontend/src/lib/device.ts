import type { DeviceContext, DeviceOs } from "@threahq/types"
import { isMobileViewport } from "@/hooks/use-mobile"

export interface DeviceSignals {
  mobileLayout: boolean
  installed: boolean
  platform: string
  userAgent: string
  maxTouchPoints: number
}

/** Whether Threa runs as an installed app (PWA) rather than a browser tab. */
export function isStandaloneApp(): boolean {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean }
  return (
    navigatorWithStandalone.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true
  )
}

export function readDeviceSignals(): DeviceSignals {
  return {
    mobileLayout: isMobileViewport(),
    installed: isStandaloneApp(),
    platform: navigator.platform ?? "",
    userAgent: navigator.userAgent ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  }
}

function osFromSignals({ platform, userAgent, maxTouchPoints }: DeviceSignals): DeviceOs {
  // Android's UA also says Linux, and iPadOS 13+ says Macintosh; both are told apart first.
  if (/Android/.test(userAgent)) return "android"
  if (/iPhone|iPod|iPad/.test(platform) || /iPhone|iPod|iPad/.test(userAgent)) return "ios"
  if (/Mac/.test(platform) && maxTouchPoints > 1) return "ios"
  if (/CrOS/.test(userAgent)) return "chromeos"
  if (/Mac/.test(platform) || /Macintosh/.test(userAgent)) return "macos"
  if (/Win/.test(platform) || /Windows/.test(userAgent)) return "windows"
  if (/Linux|X11/.test(platform) || /Linux|X11/.test(userAgent)) return "linux"
  return "other"
}

/** What the agent is told about the device in use: the layout Threa renders, the OS, and whether Threa is installed. */
export function describeDevice(signals: DeviceSignals): DeviceContext {
  return {
    layout: signals.mobileLayout ? "mobile" : "desktop",
    os: osFromSignals(signals),
    installed: signals.installed,
  }
}

interface HeartbeatInput {
  focused: boolean
  interacted: boolean
  shareDeviceWithAgents: boolean
}

/** The socket heartbeat payload; `device` is left out entirely when the user has turned sharing off. */
export function buildHeartbeatPayload({ focused, interacted, shareDeviceWithAgents }: HeartbeatInput) {
  return {
    focused,
    interacted,
    // Resolved per emit (not cached) so travel/DST changes reach the backend
    // on the next beat — it keeps users.timezone matching the device, which
    // grounds agent runs in the user's actual local time.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(shareDeviceWithAgents ? { device: describeDevice(readDeviceSignals()) } : {}),
  }
}
