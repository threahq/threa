import { StreamTypes, type NotificationLevel, type PrefNotificationLevel, type StreamType } from "@threahq/types"
import { SETTING_CHOICE_LABELS, type SettingId } from "@/components/settings/settings-registry"
import type { PushDeviceState } from "@/hooks/push-device-state"

export interface StreamPushInput {
  streamType: StreamType
  /** The stream's own level, or null when it has none. */
  level: NotificationLevel | null
  /** What it gets with no level of its own: a parent's level it follows, or else its type's default. */
  inherited: { level: NotificationLevel; from: { name: string; streamId: string } | null }
  account: PrefNotificationLevel
  quietOutsideWorkingHours: boolean
  /** The active pause as `formatNotificationPauseLabel` words it, or null when nothing is paused. */
  pauseLabel: string | null
  /** Push on this device, or null while unknown. */
  device: PushDeviceState | null
}

/** Plain text, or words that link to the setting they name or to the notification level of the stream they name. */
export type StreamPushPart = string | { text: string; setting: SettingId } | { text: string; streamId: string }

export interface StreamPushSummary {
  /** What reaches you, in one short sentence. */
  result: string
  /** Each layer that decided it, in the order the push gate applies them. */
  reasons: StreamPushPart[][]
}

/** What each level lets through from a stream. */
export const STREAM_LETS_THROUGH: Record<Exclude<NotificationLevel, "muted">, string> = {
  everything: "every message",
  activity: "@mentions, reactions and thread replies",
  mentions: "@mentions",
}

const DEVICE_BLOCKS: Partial<Record<PushDeviceState, StreamPushPart[]>> = {
  blocked: ["Your browser blocks them on ", { text: "this device", setting: "push-device" }, "."],
  off: [{ text: "Push is off on this device", setting: "push-device" }, "."],
  unsupported: [{ text: "This browser", setting: "push-device" }, " can't receive them."],
  error: [{ text: "Push on this device", setting: "push-device" }, " couldn't turn on."],
}

/**
 * What reaches you as a push from one stream: a result line, then the layers
 * behind it. The stream's level, its own or the one it inherits, decides what
 * counts, the account level filters it (mentions-only still lets DMs and
 * scratchpads through), then a pause, quiet hours and this device hold
 * delivery back; push turned off for the whole installation stops it. Mirrors
 * the backend's push gate.
 */
export function summarizeStreamPush(input: StreamPushInput, noun: string): StreamPushSummary {
  const labels = SETTING_CHOICE_LABELS["stream-notifications"]
  const { inherited } = input
  const level = input.level ?? inherited.level
  let streamReason: StreamPushPart[] = [`This ${noun} follows the ${noun} default, ${labels[inherited.level]}.`]
  if (input.level !== null) streamReason = [`This ${noun} is set to ${labels[input.level]}.`]
  else if (inherited.from) {
    streamReason = [
      `This ${noun} takes ${labels[inherited.level]} from `,
      { text: inherited.from.name, streamId: inherited.from.streamId },
      ".",
    ]
  }
  const none = `You won't get pushes from this ${noun}.`
  if (level === "muted") return { result: none, reasons: [streamReason] }

  const pushSetting = { text: "push setting", setting: "notification-level" } as const
  const account = SETTING_CHOICE_LABELS["notification-level"][input.account]
  if (input.account === "none") {
    return { result: none, reasons: [streamReason, ["Your ", pushSetting, ` is ${account}.`]] }
  }

  const direct = input.streamType === StreamTypes.DM || input.streamType === StreamTypes.SCRATCHPAD
  const filtersMentions = input.account === "mentions" && level !== "mentions"
  const narrowed = filtersMentions && !direct
  let accountTail = "."
  if (narrowed) accountTail = ", which narrows it to @mentions."
  else if (filtersMentions) accountTail = `, which still covers ${noun}s.`
  const reasons: StreamPushPart[][] = [streamReason, ["Your ", pushSetting, ` is ${account}${accountTail}`]]

  const holds: string[] = []
  if (input.pauseLabel) {
    holds.push("once your pause ends")
    reasons.push([{ text: input.pauseLabel, setting: "pause" }, "."])
  }
  if (input.quietOutsideWorkingHours) {
    holds.push("during working hours")
    reasons.push(["None arrive outside your ", { text: "working hours", setting: "quiet-hours" }, "."])
  }
  if (input.device === "server-off") {
    return {
      result: `You won't get pushes from this ${noun}. Push is off on this Threa installation.`,
      reasons: [...reasons, [{ text: "Push is off on this Threa installation", setting: "push-device" }, "."]],
    }
  }
  const device = input.device && DEVICE_BLOCKS[input.device]
  if (device) {
    holds.push("but not on this device")
    reasons.push(device)
  }

  const what = narrowed ? "@mentions only" : STREAM_LETS_THROUGH[level]
  return { result: [`You'll get pushes for ${what}`, ...holds].join(", ") + ".", reasons }
}
