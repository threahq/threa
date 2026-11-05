import { describe, expect, it } from "vitest"
import { DEFAULT_USER_PREFERENCES, DEFAULT_WORK_SCHEDULE, type UserPreferences } from "@threahq/types"
import { getCallPrefs } from "@/stores/call-prefs-store"
import { summarizeSettings, type SettingsSummaryInput } from "./use-settings-summaries"
import { SETTINGS_WITH_DEFAULTS } from "./setting-defaults"

const NOW = new Date("2026-11-04T10:00:00Z")

function prefs(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    ...DEFAULT_USER_PREFERENCES,
    workspaceId: "ws_1",
    userId: "usr_1",
    createdAt: "2026-03-01T10:00:00Z",
    updatedAt: "2026-03-01T10:00:00Z",
    ...overrides,
  }
}

function input(overrides: Partial<SettingsSummaryInput> = {}): SettingsSummaryInput {
  return {
    preferences: prefs(),
    pause: null,
    pushDevice: "on",
    pushButtonsSupported: true,
    analyticsConfigured: true,
    profile: { name: "Ada", status: null },
    workspaceName: "Acme",
    integrations: { github: { connected: 0, available: true }, linear: { connected: 0, available: true } },
    apiKeys: 2,
    personalBots: 1,
    sharedBots: 0,
    earlyFeatures: 0,
    streamMembers: undefined,
    encryption: "no-key",
    callPrefs: getCallPrefs(),
    ownHours: DEFAULT_WORK_SCHEDULE,
    workspaceHours: DEFAULT_WORK_SCHEDULE,
    defaultAgent: "Ariadne",
    workspaceDefaultAgent: "Ariadne",
    memberCount: 4,
    workspaceSubagentModels: ["model-a", "model-b"],
    stream: undefined,
    streamName: undefined,
    streamAgent: undefined,
    now: NOW,
    ...overrides,
  }
}

describe("summarizeSettings", () => {
  it("should give every setting with a default a value, so its changed-from-default row reads one", () => {
    const { values } = summarizeSettings(input())
    expect(SETTINGS_WITH_DEFAULTS.filter((id) => values[id] === undefined)).toEqual([])
  })

  it("should read a board home lens retired since it was saved as the lens it degrades to", () => {
    const { values } = summarizeSettings(
      input({ preferences: prefs({ boardDefaultLens: "retired-lens" as UserPreferences["boardDefaultLens"] }) })
    )
    expect(values["board-home"]).toBe(summarizeSettings(input()).values["board-home"])
  })

  it("gives every page of yours its current value", () => {
    const { pages } = summarizeSettings(input())

    expect({
      messages: pages.messages,
      inbox: pages.inbox,
      privacy: pages.privacy,
      notifications: pages.notifications,
      keyboard: pages.keyboard,
      members: pages.members,
      profile: pages.profile,
      workspace: pages.workspace,
      integrations: pages.integrations,
      bots: pages.bots,
      developer: pages.developer,
    }).toEqual({
      messages: "First 3 previews open · long messages in full",
      inbox: "Leaves Inbox when you reply or react",
      privacy: "No encryption · device shared with agents",
      notifications: "Push all · on for this device",
      keyboard: "Enter: send message · send on the right",
      members: "4 members",
      profile: "Ada",
      workspace: "Acme",
      integrations: "None connected",
      bots: "No bots",
      developer: "2 API keys · 1 bot",
    })
  })

  it("words the link-preview count the same in search and on the overview", () => {
    const summary = (preferences: Partial<UserPreferences>) => {
      const { values, pages } = summarizeSettings(input({ preferences: prefs(preferences) }))
      return { search: values["link-preview-count"], overview: pages.messages?.split(" · ")[0] }
    }

    expect([summary({}), summary({ linkPreviewOpenCount: 1 }), summary({ linkPreviewDefault: "collapsed" })]).toEqual([
      { search: "First 3 previews open", overview: "First 3 previews open" },
      { search: "First preview opens", overview: "First preview opens" },
      { search: "Previews collapsed", overview: "Previews collapsed" },
    ])
  })

  it("reads each overview value as a phrase that stands alone", () => {
    const pages = (overrides: Partial<SettingsSummaryInput>) => summarizeSettings(input(overrides)).pages
    const messages = (preferences: Partial<UserPreferences>) => pages({ preferences: prefs(preferences) }).messages

    expect({
      collapsed: messages({ linkPreviewDefault: "collapsed", messageCollapseEnabled: true }),
      one: messages({ linkPreviewOpenCount: 1 }),
      all: messages({ linkPreviewOpenCount: "all" }),
      oneFeature: pages({ earlyFeatures: 1 })["early-access"],
      voice: pages({
        preferences: prefs({ voicePolishLevel: "minor" }),
        callPrefs: { ...getCallPrefs(), layout: "grid" },
      }).voice,
    }).toEqual({
      collapsed: "Previews collapsed · long messages collapse",
      one: "First preview opens · long messages in full",
      all: "All previews open · long messages in full",
      oneFeature: "1 feature on",
      voice: "Dictation: light cleanup · grid layout",
    })
  })

  it("adds the active status to your name, and counts what the overview's other pages hold", () => {
    const { pages, streamPages } = summarizeSettings(
      input({
        profile: { name: "Ada", status: "In a meeting" },
        integrations: { github: { connected: 1, available: true }, linear: { connected: 1, available: true } },
        earlyFeatures: 3,
        streamMembers: 5,
        stream: { level: "mentions", type: "channel", inheritedLevel: "everything" },
        streamAgent: { mode: "off", name: "Ariadne" },
      })
    )

    expect({
      profile: pages.profile,
      integrations: pages.integrations,
      early: pages["early-access"],
      streamPages,
    }).toEqual({
      profile: "Ada · In a meeting",
      integrations: "2 connected",
      early: "3 features on",
      streamPages: { general: "Notify: mentions only", companion: "Ariadne stays quiet", members: "5 members" },
    })
  })

  it("says when push is off for this device even though the browser allows it", () => {
    const { pages, values } = summarizeSettings(input({ pushDevice: "off" }))

    expect({ notifications: pages.notifications, device: values["push-device"] }).toEqual({
      notifications: "Push all · off for this device",
      device: "Off for this device",
    })
  })

  it("never promises pushes while this installation has push off", () => {
    const { pages, values } = summarizeSettings(
      input({ preferences: prefs({ quietOutsideWorkingHours: true }), pushDevice: "server-off" })
    )

    expect({ notifications: pages.notifications, device: values["push-device"] }).toEqual({
      notifications: "Push isn't set up on this server",
      device: "Not set up on this server",
    })
  })

  it("reads crash reports and recording as the Privacy switches show them, off where this installation collects nothing", () => {
    const sharing = (analyticsConfigured: boolean | undefined, analyticsConsent: "granted" | "denied" = "granted") => {
      const { values } = summarizeSettings(
        input({ analyticsConfigured, preferences: prefs({ analyticsConsent, sessionReplayOptIn: true }) })
      )
      return [values["crash-reports"], values["session-recording"]]
    }

    expect({
      collected: sharing(true),
      notCollected: sharing(false),
      crashReportsOff: sharing(true, "denied"),
      unknown: sharing(undefined),
    }).toEqual({
      collected: ["On", "On"],
      notCollected: ["Not set up on this server", "Not set up on this server"],
      crashReportsOff: ["Off", "Off until crash reports are on"],
      unknown: [undefined, undefined],
    })
  })

  it("reads notification buttons in their row's words: its summary, or its reason when they can't show anywhere", () => {
    const buttons = (overrides: Partial<SettingsSummaryInput>) =>
      summarizeSettings(input(overrides)).values["push-buttons"]

    expect({
      shown: buttons({}),
      unsupported: buttons({ pushButtonsSupported: false }),
      noPush: buttons({ preferences: prefs({ notificationLevel: "none" }) }),
      deviceOff: buttons({ pushDevice: "blocked" }),
    }).toEqual({
      shown: "Mark read, Remind me",
      unsupported: "Only shown in desktop Chrome",
      noPush: "Shown once “Push notifications” isn't “No push”",
      deviceOff: "Mark read, Remind me",
    })
  })

  it("writes every overview line in sentence case, lower case after each ·", () => {
    const { pages } = summarizeSettings(input({ apiKeys: 0, personalBots: 0 }))
    const unknownEncryption = summarizeSettings(
      input({ encryption: "unknown", preferences: prefs({ shareDeviceWithAgents: false }) })
    ).pages

    expect({
      appearance: pages.appearance,
      developer: pages.developer,
      privacy: unknownEncryption.privacy,
    }).toEqual({
      appearance: "Match system · comfortable",
      developer: "No API keys · no bots",
      privacy: "Device not shared with agents",
    })
  })

  it("tells your default agent from the workspace's, even when they are the same", () => {
    const { pages } = summarizeSettings(input())

    expect({ ai: pages.ai, workspaceAi: pages["workspace-ai"] }).toEqual({
      ai: "Your default agent: Ariadne",
      workspaceAi: "Workspace default agent: Ariadne",
    })
  })

  it("reads a shortcut as its current binding", () => {
    const { values } = summarizeSettings(
      input({ preferences: prefs({ keyboardShortcuts: { formatBold: "mod+shift+b", searchInStream: "none" } }) })
    )

    expect({ bold: values["shortcut-formatBold"], search: values["shortcut-searchInStream"] }).toEqual({
      bold: "Ctrl+Shift+B",
      search: "No shortcut",
    })
  })

  it("names what holds pushes back: a pause, quiet hours, this device's permission", () => {
    const { pages, values } = summarizeSettings(
      input({
        preferences: prefs({ quietOutsideWorkingHours: true }),
        pause: { until: null, source: "manual" },
        pushDevice: "blocked",
      })
    )

    expect({ notifications: pages.notifications, pause: values.pause, device: values["push-device"] }).toEqual({
      notifications: "Push all · paused · quiet outside working hours · blocked on this device",
      pause: "Notifications paused",
      device: "Blocked on this device",
    })
    expect(summarizeSettings(input()).values.pause).toBe("Not paused")
  })

  it("reads choice settings the way their rows word them", () => {
    const { values } = summarizeSettings(
      input({ preferences: prefs({ inboxClearMode: "read", unreadOpenPosition: "marker" }) })
    )

    expect({
      settling: values.settling,
      landing: values["unread-landing"],
      mirror: values["call-mirror"],
    }).toEqual({
      settling: "Leaves Inbox as soon as you read it",
      landing: "Opens at your first unread",
      mirror: "Mirror automatically",
    })
  })

  it("reads subagent models as the picker resolves them: an empty list follows the workspace's", () => {
    const value = (subagentModels: string[]) =>
      summarizeSettings(input({ preferences: prefs({ subagentModels }) })).values["subagent-models"]

    expect([value([]), value(["model-b"]), value(["model-gone"])]).toEqual([
      "Workspace models · 2",
      "1 model",
      "None allowed",
    ])
  })

  it("says when this installation offers no integrations, on the overview and beside each provider's search result", () => {
    const { pages, values } = summarizeSettings(
      input({
        integrations: { github: { connected: 0, available: false }, linear: { connected: 0, available: false } },
      })
    )

    expect({
      page: pages.integrations,
      github: values["github-integration"],
      linear: values["linear-integration"],
    }).toEqual({
      page: "Not set up on this server",
      github: "Not set up on this server",
      linear: "Not set up on this server",
    })
  })

  it("summarizes each provider beside its own search result", () => {
    const { values } = summarizeSettings(
      input({ integrations: { github: { connected: 2, available: true }, linear: { connected: 0, available: true } } })
    )

    expect({ github: values["github-integration"], linear: values["linear-integration"] }).toEqual({
      github: "2 accounts connected",
      linear: "Not connected",
    })
  })

  it("names the workspace and the stream in view beside their name results", () => {
    const { values } = summarizeSettings(input({ streamName: "#design" }))

    expect({ workspace: values["workspace-name"], stream: values["stream-name"] }).toEqual({
      workspace: "Acme",
      stream: "#design",
    })
  })

  it('reads the stream\'s agent as who and whether it replies, "Agent" until the name is known', () => {
    const companion = (streamAgent: SettingsSummaryInput["streamAgent"]) =>
      summarizeSettings(input({ streamAgent })).streamPages.companion

    expect([
      companion({ mode: "on", name: "Ariadne" }),
      companion({ mode: "off", name: "Ariadne" }),
      companion({ mode: "on", name: undefined }),
    ]).toEqual(["Ariadne replies", "Ariadne stays quiet", "Agent replies"])
  })

  it("names the level a stream left on its default inherits, not its type's default", () => {
    const general = (stream: SettingsSummaryInput["stream"]) => summarizeSettings(input({ stream })).streamPages.general

    expect([
      general({ level: "default", type: "thread", inheritedLevel: "muted" }),
      general({ level: "default", type: "channel", inheritedLevel: "mentions" }),
      general({ level: "everything", type: "thread", inheritedLevel: "muted" }),
    ]).toEqual(["Notify: thread default · muted", "Notify: channel default · mentions only", "Notify: everything"])
  })

  it("says what device sharing tells agents, not just that it is on", () => {
    const value = (shareDeviceWithAgents: boolean) =>
      summarizeSettings(input({ preferences: prefs({ shareDeviceWithAgents }) })).values["device-sharing"]

    expect([value(true), value(false)]).toEqual(["Layout, system and open docs", "Not shared"])
  })
})
