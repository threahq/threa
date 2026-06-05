import { describe, it, expect } from "bun:test"
import {
  resolveActiveStatus,
  resolveNotificationPause,
  presetPausesNotifications,
  isStatusContentful,
  SYSTEM_DEFAULT_STATUSES,
  STATUS_TEXT_MAX_LENGTH,
  type UserStatusFields,
  type UserNotificationPauseFields,
} from "./user-status"

describe("isStatusContentful", () => {
  it("requires an emoji or non-empty text", () => {
    expect(isStatusContentful({ emoji: null, text: null })).toBe(false)
    expect(isStatusContentful({ emoji: null, text: "   " })).toBe(false)
    expect(isStatusContentful({ emoji: "dart", text: null })).toBe(true)
    expect(isStatusContentful({ emoji: null, text: "Focusing" })).toBe(true)
    expect(isStatusContentful({ emoji: "dart", text: "Focusing" })).toBe(true)
  })
})

describe("resolveActiveStatus", () => {
  const now = new Date("2026-06-04T12:00:00Z")

  it("returns null when there is no content", () => {
    expect(resolveActiveStatus({ statusEmoji: null, statusText: null, statusExpiresAt: null }, now)).toBeNull()
  })

  it("returns the status when indefinite", () => {
    expect(resolveActiveStatus({ statusEmoji: "dart", statusText: "Focus", statusExpiresAt: null }, now)).toEqual({
      emoji: "dart",
      text: "Focus",
      expiresAt: null,
    })
  })

  it("masks a status whose expiry has passed", () => {
    const expired = new Date(now.getTime() - 60_000).toISOString()
    expect(resolveActiveStatus({ statusEmoji: "dart", statusText: "Focus", statusExpiresAt: expired }, now)).toBeNull()
  })

  it("keeps a status whose expiry is still in the future", () => {
    const future = new Date(now.getTime() + 60_000).toISOString()
    const result = resolveActiveStatus({ statusEmoji: null, statusText: "Out", statusExpiresAt: future }, now)
    expect(result).toEqual({ emoji: null, text: "Out", expiresAt: future })
  })
})

describe("resolveNotificationPause", () => {
  const now = new Date("2026-06-04T12:00:00Z")
  const future = new Date(now.getTime() + 60 * 60_000).toISOString()
  const past = new Date(now.getTime() - 60_000).toISOString()

  const fields = (
    over: Partial<UserStatusFields & UserNotificationPauseFields> = {}
  ): UserStatusFields & UserNotificationPauseFields => ({
    statusEmoji: null,
    statusText: null,
    statusExpiresAt: null,
    statusPausesNotifications: false,
    notificationsPausedUntil: null,
    notificationsPausedIndefinitely: false,
    ...over,
  })

  it("returns null when nothing is paused", () => {
    expect(resolveNotificationPause(fields(), now)).toBeNull()
    // A status that does not pause notifications never silences them.
    expect(
      resolveNotificationPause(fields({ statusEmoji: "dart", statusText: "Focus", statusExpiresAt: future }), now)
    ).toBeNull()
  })

  it("pauses for the status window when the active status pauses notifications", () => {
    expect(
      resolveNotificationPause(
        fields({
          statusEmoji: "no_bell",
          statusText: "Do not disturb",
          statusExpiresAt: future,
          statusPausesNotifications: true,
        }),
        now
      )
    ).toEqual({ until: future, source: "status" })
  })

  it("ignores the pause flag once the status itself has expired", () => {
    expect(
      resolveNotificationPause(
        fields({
          statusEmoji: "no_bell",
          statusText: "Do not disturb",
          statusExpiresAt: past,
          statusPausesNotifications: true,
        }),
        now
      )
    ).toBeNull()
  })

  it("honors a manual timed pause and masks an elapsed one", () => {
    expect(resolveNotificationPause(fields({ notificationsPausedUntil: future }), now)).toEqual({
      until: future,
      source: "manual",
    })
    expect(resolveNotificationPause(fields({ notificationsPausedUntil: past }), now)).toBeNull()
  })

  it("treats an indefinite manual pause as no end", () => {
    expect(resolveNotificationPause(fields({ notificationsPausedIndefinitely: true }), now)).toEqual({
      until: null,
      source: "manual",
    })
  })

  it("reports both sources and keeps the later end", () => {
    const later = new Date(now.getTime() + 120 * 60_000).toISOString()
    expect(
      resolveNotificationPause(
        fields({
          statusEmoji: "no_bell",
          statusText: "DND",
          statusExpiresAt: future,
          statusPausesNotifications: true,
          notificationsPausedUntil: later,
        }),
        now
      )
    ).toEqual({ until: later, source: "both" })
  })

  it("an indefinite source outlasts any concrete end when both are active", () => {
    expect(
      resolveNotificationPause(
        fields({
          statusEmoji: "no_bell",
          statusText: "DND",
          statusExpiresAt: future,
          statusPausesNotifications: true,
          notificationsPausedIndefinitely: true,
        }),
        now
      )
    ).toEqual({ until: null, source: "both" })
  })
})

describe("presetPausesNotifications", () => {
  it("defaults to false when the flag is absent", () => {
    expect(presetPausesNotifications({ pausesNotifications: undefined })).toBe(false)
    expect(presetPausesNotifications({ pausesNotifications: true })).toBe(true)
    expect(presetPausesNotifications({ pausesNotifications: false })).toBe(false)
  })
})

describe("SYSTEM_DEFAULT_STATUSES", () => {
  it("are all contentful, uniquely identified, and within the text bound", () => {
    const ids = new Set<string>()
    for (const preset of SYSTEM_DEFAULT_STATUSES) {
      expect(isStatusContentful(preset)).toBe(true)
      expect(ids.has(preset.id)).toBe(false)
      ids.add(preset.id)
      if (preset.text) expect(preset.text.length).toBeLessThanOrEqual(STATUS_TEXT_MAX_LENGTH)
    }
  })

  it("matches the product-specified defaults", () => {
    expect(SYSTEM_DEFAULT_STATUSES.map((p) => p.text)).toEqual([
      "Focus mode",
      "Out and about",
      "Out of office",
      "Sick",
      "Do not disturb",
      "VAB",
    ])
    const byId = (id: string) => SYSTEM_DEFAULT_STATUSES.find((p) => p.id === id)
    expect({
      focus: byId("focus")?.defaultDuration,
      outOfOffice: byId("out-of-office")?.defaultDuration,
      sick: byId("sick")?.defaultDuration,
      doNotDisturb: byId("do-not-disturb")?.defaultDuration,
      vab: byId("vab")?.defaultDuration,
    }).toEqual({
      focus: { kind: "duration", minutes: 60 },
      outOfOffice: { kind: "calendar", calendar: "tomorrow-start" },
      sick: { kind: "calendar", calendar: "next-working-day-start" },
      doNotDisturb: null,
      vab: null,
    })
  })

  it("only the do-not-disturb preset pauses notifications by default", () => {
    const pausing = SYSTEM_DEFAULT_STATUSES.filter((p) => presetPausesNotifications(p)).map((p) => p.id)
    expect(pausing).toEqual(["do-not-disturb"])
  })
})
