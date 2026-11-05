import { describe, expect, it } from "vitest"
import { SETTINGS_TABS, StreamTypes } from "@threahq/types"
import {
  SETTINGS,
  SETTINGS_SECTIONS,
  STREAM_SETTINGS,
  STREAM_SETTINGS_SECTIONS,
  searchSettings,
  relatedSetting,
  settingResultTrail,
  settingsOfSection,
  streamSettingsTabs,
  type SettingsSectionId,
  type SettingsVisibility,
  type StreamSettingsSectionId,
} from "./settings-registry"

const everything: SettingsVisibility = { tabs: SETTINGS_TABS, hidden: new Set() }

function topIds(query: string, context?: Parameters<typeof searchSettings>[2]): string[] {
  return searchSettings(query, everything, context)
    .slice(0, 3)
    .map((result) => result.id)
}

describe("searchSettings", () => {
  it.each([
    ["why does only the first link show a preview", "link-preview-count"],
    ["why did my stream disappear from the inbox", "settling"],
    ["notifcations", "notification-level"],
    ["dark", "theme"],
    ["left handed", "send-side"],
    ["rename workspace", "workspace-name"],
    ["quiet", "quiet-hours"],
    ["channel notifications", "notification-level"],
    ["tiemzone", "timezone"],
    ["zoon", "font-size"],
    ["encryption pin", "encryption-unlock-method"],
    ["stay unlocked", "encryption-keep-unlocked"],
  ])("%s → %s in the top 3", (query, expected) => {
    expect(topIds(query)).toContain(expected)
  })

  it("ranks the setting the whole query names first", () => {
    expect(topIds("theme")[0]).toBe("theme")
    expect(topIds("pronouns")[0]).toBe("pronouns")
  })

  it("finds the workspace's spend limits by budget or cost", () => {
    expect(["spend limit", "budget", "AI cost"].map((query) => topIds(query)[0])).toEqual([
      "spend-limits",
      "spend-limits",
      "spend-limits",
    ])
  })

  it("ranks a setting its label or keywords name over one found only through its page or description", () => {
    const preview = topIds("preview")
    expect(preview[0]).toMatch(/^link-preview/)
    expect(preview[1]).not.toBe("message-collapse-to")
    const stream = {
      type: StreamTypes.CHANNEL,
      tabs: streamSettingsTabs({ type: "channel", parentStreamId: null }, false),
    }
    expect(searchSettings("mute channel", everything, { stream }).map((result) => result.id)).not.toContain(
      "stream-replies"
    )
  })

  it("keeps equally good matches in the order their page shows them", () => {
    const ids = searchSettings("notifcations", everything).map((result) => result.id)
    expect(ids.indexOf("push-device")).toBeLessThan(ids.indexOf("push-buttons"))
  })

  it("finds the new pages by what they hold", () => {
    expect(topIds("board card height")).toContain("board-card-collapse-to")
    expect(searchSettings("feature flags", everything)[0]).toMatchObject({
      id: "feature-flags",
      target: { kind: "settings", tab: "early-access" },
    })
  })

  it("follows a one-word query's best match with the rest of its section, marked related", () => {
    const results = searchSettings("preview", everything)
    expect(results.slice(0, 2).map(({ id, related }) => ({ id, related }))).toEqual([
      { id: "link-preview-count", related: undefined },
      { id: "link-preview-types", related: true },
    ])
    expect(searchSettings("theme", everything).find((result) => result.id === "density")?.related).toBe(true)
  })

  it("answers a task sentence with what it names, not its section neighbours or filler-word matches", () => {
    expect(searchSettings("rename workspace", everything).map((result) => result.id)).toEqual(["workspace-name"])
    const inbox = searchSettings("why did my stream disappear from the inbox", everything).map((result) => result.id)
    expect(inbox[0]).toBe("settling")
    expect(inbox).not.toContain("label-move")
  })

  it("lists settings that only match part of a task under Related once one setting matches all of it", () => {
    const stream = {
      type: StreamTypes.CHANNEL,
      tabs: streamSettingsTabs({ type: "channel", parentStreamId: null }, false),
      name: "#design",
    }
    const split = (query: string) => {
      const results = searchSettings(query, everything, { stream })
      return {
        direct: results.filter((result) => !result.related).map((result) => result.id),
        related: results.filter((result) => result.related).map((result) => result.id),
      }
    }

    expect({ rename: split("rename workspace"), mute: split("mute channel") }).toEqual({
      rename: { direct: ["workspace-name"], related: ["stream-name"] },
      mute: { direct: ["stream-notifications"], related: ["pause"] },
    })
  })

  it("finds quiet hours among the notification settings", () => {
    expect(searchSettings("notifications", everything).map((result) => result.id)).toContain("quiet-hours")
  })

  it("names the stream a stream result belongs to", () => {
    const stream = {
      type: StreamTypes.CHANNEL,
      tabs: streamSettingsTabs({ type: "channel", parentStreamId: null }, false),
      name: "#design",
    }
    const [result] = searchSettings("mute channel", everything, { stream })
    expect(settingResultTrail(result)).toBe("#design › General › Your notifications")
  })

  it("finds a shortcut by the chord bound to it now or by default, however it is written", () => {
    expect(topIds("change bold from cmd+b to cmd+f")[0]).toBe("shortcut-formatBold")
    expect(topIds("ctrl+b")[0]).toBe("shortcut-formatBold")
    expect(topIds("⌘b")[0]).toBe("shortcut-formatBold")
    expect(topIds("cmd+j", { shortcutBindings: { formatBold: "mod+j" } })[0]).toBe("shortcut-formatBold")
  })

  it("shows what already holds each chord a query names, apart from the action it asks for", () => {
    const owners = (query: string, context?: Parameters<typeof searchSettings>[2]) =>
      searchSettings(query, everything, context)
        .filter((result) => result.keysInUse)
        .map((result) => result.id)

    expect(topIds("change bold from cmd+b to cmd+f")[0]).toBe("shortcut-formatBold")
    expect(owners("change bold from cmd+b to cmd+f")).toEqual(["shortcut-searchInStream"])
    expect(owners("change bold from cmd+b to cmd+f", { shortcutBindings: { searchInStream: "mod+g" } })).toEqual([])
    expect(owners("change bold from cmd+b to cmd+g", { shortcutBindings: { searchInStream: "mod+g" } })).toEqual([
      "shortcut-searchInStream",
    ])
  })

  it("answers a sentence naming two settings with both", () => {
    expect(searchSettings("change my avatar and display name", everything).map((result) => result.id)).toEqual(
      expect.arrayContaining(["display-name", "avatar"])
    )
  })

  it.each(["the weather is nice this weekend", "how do I bake bread"])("finds nothing for %s", (query) => {
    expect(searchSettings(query, everything)).toEqual([])
  })

  it("labels the workspace and stream name results by what they name", () => {
    expect([SETTINGS["workspace-name"].label, STREAM_SETTINGS["stream-name"].label]).toEqual([
      "Workspace name",
      "Stream name",
    ])
  })

  it("offers this stream's settings with a stream in context, and any stream's without one", () => {
    expect(topIds("mute channel")).not.toContain("stream-notifications")
    expect(
      searchSettings("mute channel", everything, { anyStreamTabs: ["general", "companion", "members"] })[0]
    ).toMatchObject({ id: "stream-notifications", needsStream: true, target: { kind: "stream", tab: "general" } })
    expect(
      searchSettings("share with another workspace", everything, { anyStreamTabs: ["general"] }).map((r) => r.id)
    ).not.toContain("stream-connect")
    const stream = {
      type: StreamTypes.CHANNEL,
      tabs: streamSettingsTabs({ type: "channel", parentStreamId: null }, false),
    }
    expect(topIds("mute channel", { stream })[0]).toBe("stream-notifications")
    expect(searchSettings("mute channel", everything, { stream })[0]).toMatchObject({
      scope: "stream",
      target: { kind: "stream", tab: "general", anchor: "stream-notifications" },
      path: ["General", "Your notifications"],
    })
  })

  it("leaves out stream settings the stream type or its tabs don't have", () => {
    const dm = { type: StreamTypes.DM, tabs: streamSettingsTabs({ type: "dm", parentStreamId: null }, true) }
    const ids = searchSettings("archive share with another workspace", everything, { stream: dm }).map((r) => r.id)
    expect(ids).not.toContain("stream-archive")
    expect(ids).not.toContain("stream-connect")
  })

  it("skips tabs and settings the viewer can't see", () => {
    const visibility: SettingsVisibility = {
      tabs: SETTINGS_TABS.filter((tab) => tab !== "workspace"),
      hidden: new Set(["theme"]),
    }
    const ids = searchSettings("rename workspace dark", visibility).map((r) => r.id)
    expect(ids).not.toContain("workspace-name")
    expect(ids).not.toContain("theme")
  })

  it("labels a result by its scope, page and section", () => {
    expect(searchSettings("previews to expand", everything)[0]).toMatchObject({
      id: "link-preview-count",
      scope: "you",
      path: ["Reading", "Link previews"],
      target: { kind: "settings", tab: "messages", anchor: "link-preview-count" },
    })
  })
})

describe("registry", () => {
  it("never opens a section with a row that repeats its title", () => {
    const repeats = (Object.keys(SETTINGS_SECTIONS) as SettingsSectionId[]).flatMap((section) => {
      const [first] = settingsOfSection(section)
      if (!first) return []
      const title = SETTINGS_SECTIONS[section].title.toLowerCase()
      return SETTINGS[first].label.toLowerCase().startsWith(title) ? [`${section}: ${SETTINGS[first].label}`] : []
    })
    const streamRepeats = (Object.keys(STREAM_SETTINGS_SECTIONS) as StreamSettingsSectionId[]).flatMap((section) => {
      const first = Object.values(STREAM_SETTINGS).find((def) => def.section === section)
      if (!first) return []
      const title = STREAM_SETTINGS_SECTIONS[section].title.toLowerCase()
      return first.label.toLowerCase().startsWith(title) ? [`${section}: ${first.label}`] : []
    })
    expect([...repeats, ...streamRepeats]).toEqual([])
  })

  it("pairs each personal setting with its workspace twin, both ways, and links a dependent setting to its owner", () => {
    expect(
      (["working-hours", "default-working-hours", "steering-words", "quiet-hours", "theme"] as const).map((id) =>
        relatedSetting(id)
      )
    ).toEqual(["default-working-hours", "working-hours", "shared-steering-words", "working-hours", null])
  })

  it("keeps a personal setting and its twin apart by name", () => {
    const labels = Object.values(SETTINGS).map((def) => def.label)
    expect(labels.filter((label, index) => labels.indexOf(label) !== index)).toEqual([])
  })

  it("derives a stream's settings tabs from its type", () => {
    expect({
      channel: streamSettingsTabs({ type: "channel", parentStreamId: null }, true),
      scratchpad: streamSettingsTabs({ type: "scratchpad", parentStreamId: null }, true),
      system: streamSettingsTabs({ type: "system", parentStreamId: null }, true),
    }).toEqual({
      channel: ["general", "companion", "members", "connect"],
      scratchpad: ["general", "companion", "members"],
      system: ["general"],
    })
  })
})
