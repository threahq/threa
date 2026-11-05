import { describe, expect, it } from "vitest"
import { StreamTypes } from "@threahq/types"
import { SETTING_CHOICE_LABELS } from "@/components/settings/settings-registry"
import { summarizeStreamPush, type StreamPushInput } from "./stream-push-summary"

const PUSH = SETTING_CHOICE_LABELS["notification-level"]

const base: StreamPushInput = {
  streamType: StreamTypes.CHANNEL,
  level: null,
  inherited: { level: "mentions", from: null },
  account: "all",
  quietOutsideWorkingHours: false,
  pauseLabel: null,
  device: "on",
}

function explain(input: Partial<StreamPushInput>, noun = "channel") {
  const { result, reasons } = summarizeStreamPush({ ...base, ...input }, noun)
  return {
    result,
    reasons: reasons.map((reason) =>
      reason
        .map((part) => {
          if (typeof part === "string") return part
          return `[${part.text}→${"setting" in part ? part.setting : part.streamId}]`
        })
        .join("")
    ),
  }
}

describe("summarizeStreamPush", () => {
  it("leads with what pushes, then the stream's level and the account level, including a stream on its type's default", () => {
    expect(explain({})).toEqual({
      result: "You'll get pushes for @mentions.",
      reasons: [
        "This channel follows the channel default, Mentions only.",
        `Your [push setting→notification-level] is ${PUSH.all}.`,
      ],
    })
    expect(explain({ streamType: StreamTypes.THREAD, inherited: { level: "activity", from: null } }, "thread")).toEqual(
      {
        result: "You'll get pushes for @mentions, reactions and thread replies.",
        reasons: [
          "This thread follows the thread default, Activity.",
          `Your [push setting→notification-level] is ${PUSH.all}.`,
        ],
      }
    )
  })

  it("names the parent a stream with no level of its own follows, and links to its level", () => {
    const thread = (level: "muted" | "activity") =>
      explain(
        {
          streamType: StreamTypes.THREAD,
          inherited: { level, from: { name: "#general", streamId: "stream_general" } },
        },
        "thread"
      )
    expect({ muted: thread("muted"), activity: thread("activity") }).toEqual({
      muted: {
        result: "You won't get pushes from this thread.",
        reasons: ["This thread takes Muted from [#general→stream_general]."],
      },
      activity: {
        result: "You'll get pushes for @mentions, reactions and thread replies.",
        reasons: [
          "This thread takes Activity from [#general→stream_general].",
          `Your [push setting→notification-level] is ${PUSH.all}.`,
        ],
      },
    })
  })

  it("lets the stream's own level win over the one it would inherit", () => {
    expect(
      explain(
        {
          streamType: StreamTypes.THREAD,
          level: "everything",
          inherited: { level: "muted", from: { name: "#general", streamId: "stream_general" } },
        },
        "thread"
      ).reasons[0]
    ).toBe("This thread is set to Everything.")
  })

  it("passes every message through when both levels allow it", () => {
    expect(explain({ level: "everything" }).result).toBe("You'll get pushes for every message.")
  })

  it("says the account setting narrows a channel to mentions", () => {
    expect(explain({ level: "everything", account: "mentions" })).toEqual({
      result: "You'll get pushes for @mentions only.",
      reasons: [
        "This channel is set to Everything.",
        `Your [push setting→notification-level] is ${PUSH.mentions}, which narrows it to @mentions.`,
      ],
    })
  })

  it("keeps DMs and scratchpads whole under mentions-only, as the push gate does", () => {
    expect(
      explain({ streamType: StreamTypes.DM, inherited: { level: "everything", from: null }, account: "mentions" }, "DM")
    ).toEqual({
      result: "You'll get pushes for every message.",
      reasons: [
        "This DM follows the DM default, Everything.",
        `Your [push setting→notification-level] is ${PUSH.mentions}, which still covers DMs.`,
      ],
    })
  })

  it("says nothing pushes from a muted stream, without blaming the account or anything else", () => {
    expect(explain({ level: "muted", account: "none", pauseLabel: "Notifications paused", device: "blocked" })).toEqual(
      {
        result: "You won't get pushes from this channel.",
        reasons: ["This channel is set to Muted."],
      }
    )
  })

  it("blames the account when push is off there, and nothing after it", () => {
    expect(explain({ level: "everything", account: "none", quietOutsideWorkingHours: true, device: "off" })).toEqual({
      result: "You won't get pushes from this channel.",
      reasons: ["This channel is set to Everything.", `Your [push setting→notification-level] is ${PUSH.none}.`],
    })
  })

  it("qualifies the result with an active pause, quiet hours and this device, and links each reason", () => {
    expect(
      explain({
        level: "everything",
        pauseLabel: "Notifications paused until 14:30",
        quietOutsideWorkingHours: true,
        device: "blocked",
      })
    ).toEqual({
      result:
        "You'll get pushes for every message, once your pause ends, during working hours, but not on this device.",
      reasons: [
        "This channel is set to Everything.",
        `Your [push setting→notification-level] is ${PUSH.all}.`,
        "[Notifications paused until 14:30→pause].",
        "None arrive outside your [working hours→quiet-hours].",
        "Your browser blocks them on [this device→push-device].",
      ],
    })
  })

  it("names this device only when it holds pushes back", () => {
    const device = (state: StreamPushInput["device"]) => explain({ level: "everything", device: state }).reasons[2]
    expect({
      on: device("on"),
      subscribing: device("subscribing"),
      unknown: device(null),
      off: device("off"),
      unsupported: device("unsupported"),
      error: device("error"),
    }).toEqual({
      on: undefined,
      subscribing: undefined,
      unknown: undefined,
      off: "[Push is off on this device→push-device].",
      unsupported: "[This browser→push-device] can't receive them.",
      error: "[Push on this device→push-device] couldn't turn on.",
    })
  })

  it("says nothing pushes while push isn't set up on the server, naming that as the last reason", () => {
    expect(explain({ quietOutsideWorkingHours: true, device: "server-off" })).toEqual({
      result: "You won't get pushes from this channel. Push isn't set up on this Threa server.",
      reasons: [
        "This channel follows the channel default, Mentions only.",
        `Your [push setting→notification-level] is ${PUSH.all}.`,
        "None arrive outside your [working hours→quiet-hours].",
        "[Push isn't set up on this Threa server→push-device].",
      ],
    })
  })
})
