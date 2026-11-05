import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { ServicesProvider, SettingsProvider, type StreamService } from "@/contexts"
import * as preferencesModule from "@/contexts/preferences-context"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as pushModule from "@/hooks/use-push-notifications"
import * as e2eSession from "@/stores/e2e-session-store"
import * as descriptionSectionModule from "./description-section"
import {
  StreamTypes,
  Visibilities,
  MemoryModes,
  type NotificationLevel,
  type PrefNotificationLevel,
  type Stream,
} from "@threahq/types"
import { SETTING_CHOICE_LABELS } from "@/components/settings/settings-registry"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB so the workspace store reads a real parent level
import { db, type CachedStream, type CachedStreamMembership, type CachedUnreadState } from "@/db"
import { resetWorkspaceStoreCache, seedWorkspaceCache } from "@/stores/workspace-store"
import { resetWorkspaceTableRegistry } from "@/stores/workspace-table-registry"
import { GeneralTab } from "./general-tab"

const WS = "ws_1"
const USER = "usr_alice"

const CHANNEL = {
  id: "stream_chan_1",
  workspaceId: WS,
  type: StreamTypes.CHANNEL,
  displayName: "Launch",
  slug: "launch",
  description: null,
  visibility: Visibilities.PUBLIC,
  parentStreamId: null,
  rootStreamId: null,
  companionMode: "off",
  companionPersonaId: null,
  memoryMode: MemoryModes.AUTO,
  createdBy: USER,
  createdAt: "2026-06-17T10:00:00Z",
  updatedAt: "2026-06-17T10:00:00Z",
  archivedAt: null,
} as Stream

const THREAD = {
  ...CHANNEL,
  id: "stream_thread_1",
  type: StreamTypes.THREAD,
  displayName: "Launch plan",
  slug: null,
  visibility: Visibilities.PRIVATE,
  parentStreamId: CHANNEL.id,
  rootStreamId: CHANNEL.id,
} as Stream

/** The workspace caches as a bootstrap leaves them: the channel, your level on it, and the server's muted set. */
async function seedChannelLevel(
  notificationLevel: NotificationLevel | null,
  { archivedAt = null, mutedStreamIds }: { archivedAt?: string | null; mutedStreamIds?: string[] } = {}
) {
  const cachedAt = Date.now()
  const streams = [{ ...CHANNEL, archivedAt, lastMessagePreview: null, _cachedAt: cachedAt } as unknown as CachedStream]
  const memberships = [
    {
      id: `${WS}:${CHANNEL.id}`,
      workspaceId: WS,
      streamId: CHANNEL.id,
      memberId: USER,
      notificationLevel,
      _cachedAt: cachedAt,
    } as unknown as CachedStreamMembership,
  ]
  const unreadState = mutedStreamIds
    ? ({
        id: WS,
        workspaceId: WS,
        unreadCounts: {},
        mutedStreamIds,
        _cachedAt: cachedAt,
      } as unknown as CachedUnreadState)
    : undefined
  await db.streams.bulkPut(streams)
  await db.streamMemberships.bulkPut(memberships)
  seedWorkspaceCache(WS, {
    unreadState,
    workspace: { id: WS, name: "Workspace", slug: "workspace", createdAt: "", updatedAt: "", _cachedAt: cachedAt },
    users: [],
    streams,
    memberships,
    dmPeers: [],
    personas: [],
    bots: [],
  })
}

function accountLevel(notificationLevel: PrefNotificationLevel, extra: { quietOutsideWorkingHours?: boolean } = {}) {
  vi.spyOn(preferencesModule, "usePreferencesOptional").mockReturnValue({
    preferences: { notificationLevel, ...extra },
  } as unknown as ReturnType<typeof preferencesModule.usePreferencesOptional>)
}

function pushOnThisDevice(push: Partial<ReturnType<typeof pushModule.usePushNotifications>>) {
  vi.spyOn(pushModule, "usePushNotifications").mockReturnValue({
    permission: "granted",
    isSubscribed: true,
    status: "subscribed",
    error: null,
    optedOut: false,
    pushDisabledOnServer: false,
    ...push,
  } as ReturnType<typeof pushModule.usePushNotifications>)
}

const PUSH = SETTING_CHOICE_LABELS["notification-level"]

function renderTab({
  notificationLevel,
  stream = CHANNEL,
}: {
  notificationLevel: NotificationLevel | null
  stream?: Stream
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/w/${WS}/s/${stream.id}`]}>
        <SettingsProvider>
          <ServicesProvider services={{ streams: { update: vi.fn() } as unknown as StreamService }}>
            <GeneralTab
              workspaceId={WS}
              stream={stream}
              currentUserId={USER}
              notificationLevel={notificationLevel}
              rootStream={stream.rootStreamId ? CHANNEL : null}
            />
          </ServicesProvider>
        </SettingsProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("GeneralTab notifications and the account push level", () => {
  beforeEach(async () => {
    resetWorkspaceStoreCache()
    resetWorkspaceTableRegistry()
    await db.streams.clear()
    await db.streamMemberships.clear()
    pushOnThisDevice({})
    vi.spyOn(useWorkspacesModule, "useCurrentWorkspaceUser").mockReturnValue(null)
    vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue(USER)
    vi.spyOn(descriptionSectionModule, "DescriptionSection").mockImplementation(() => (
      <div data-testid="description-section" />
    ))
    vi.spyOn(e2eSession, "useE2eSession").mockReturnValue({
      status: "locked",
      keyId: null,
      publicKey: null,
      privateKey: null,
      deviceTrusted: false,
      error: null,
    } as ReturnType<typeof e2eSession.getE2eSessionState>)
  })

  afterEach(() => vi.restoreAllMocks())

  it("states what pushes in one line, with the layers behind it a disclosure away", async () => {
    accountLevel("mentions")
    renderTab({ notificationLevel: "everything" })

    const group = screen.getByRole("radiogroup", { name: "Notify me about" })
    expect(group).toHaveAccessibleDescription(/You'll get pushes for @mentions only\./)
    expect(screen.queryByRole("link", { name: "push setting" })).toBeNull()

    const why = screen.getByRole("button", { name: "Why" })
    await userEvent.click(why)

    expect({
      expanded: why.getAttribute("aria-expanded"),
      reasons: screen.getByTestId("stream-push-reasons").textContent,
      link: screen.getByRole("link", { name: "push setting" }).getAttribute("href"),
    }).toEqual({
      expanded: "true",
      reasons: `This channel is set to Everything.Your push setting is ${PUSH.mentions}, which narrows it to @mentions.`,
      link: `/w/${WS}/s/${CHANNEL.id}?settings=notifications&setting=notification-level`,
    })
  })

  it("says the default follows the channel default, and marks the level it equals as not following it", () => {
    accountLevel("all")
    renderTab({ notificationLevel: null })

    const option = (name: RegExp) => {
      const radio = screen.getByRole("radio", { name })
      const id = radio.getAttribute("aria-describedby")
      return {
        checked: radio.getAttribute("aria-checked"),
        description: id ? document.getElementById(id)?.textContent : null,
      }
    }
    expect({
      followDefault: option(/^Channel default/),
      matching: option(/^Mentions only/),
      other: option(/^Everything/),
    }).toEqual({
      followDefault: { checked: "true", description: "Follows the default for channels, now mentions only." },
      matching: { checked: "false", description: "Same as the default now, but stays if the default changes." },
      other: { checked: "false", description: "Every message." },
    })
  })

  it("names and links the muted parent a thread with no level of its own follows", async () => {
    accountLevel("all")
    await seedChannelLevel("muted")
    renderTab({ notificationLevel: null, stream: THREAD })

    expect(await screen.findByRole("radio", { name: /^Thread default/ })).toHaveAccessibleDescription(
      "Follows #launch, now muted."
    )
    expect(screen.getByTestId("stream-push-summary")).toHaveTextContent("You won't get pushes from this thread.")
    await userEvent.click(screen.getByRole("button", { name: "Why" }))
    expect({
      reasons: screen.getByTestId("stream-push-reasons").textContent,
      link: screen.getByRole("link", { name: "#launch" }).getAttribute("href"),
    }).toEqual({
      reasons: "This thread takes Muted from #launch.",
      link: `/w/${WS}/s/${THREAD.id}?stream-settings=general&sid=${CHANNEL.id}&setting=stream-notifications`,
    })
  })

  it("keeps the thread default under a parent whose level carries nothing, and says muting the parent mutes it", async () => {
    accountLevel("all")
    await seedChannelLevel("mentions")
    renderTab({ notificationLevel: null, stream: THREAD })

    expect(await screen.findByRole("radio", { name: /^Thread default/ })).toHaveAccessibleDescription(
      "Follows the default for threads, now activity. Mutes with #launch."
    )
    expect(screen.getByTestId("stream-push-summary")).toHaveTextContent(
      "You'll get pushes for @mentions, reactions and thread replies."
    )
  })

  it("takes an archived parent's mute from the server's muted set, as the Inbox does", async () => {
    accountLevel("all")
    await seedChannelLevel(null, { archivedAt: "2026-06-18T10:00:00Z", mutedStreamIds: [THREAD.id] })
    renderTab({ notificationLevel: null, stream: THREAD })

    expect(await screen.findByRole("radio", { name: /^Thread default/ })).toHaveAccessibleDescription(
      "Follows #launch, now muted."
    )
    expect(screen.getByTestId("stream-push-summary")).toHaveTextContent("You won't get pushes from this thread.")
  })

  it("falls back to the thread default under an archived parent when there is no server muted set", async () => {
    accountLevel("all")
    await seedChannelLevel("muted", { archivedAt: "2026-06-18T10:00:00Z" })
    renderTab({ notificationLevel: null, stream: THREAD })

    expect(await screen.findByRole("radio", { name: /^Thread default/ })).toHaveAccessibleDescription(
      /^Follows the default for threads, now activity\./
    )
  })

  it("says every message pushes when both levels allow it", () => {
    accountLevel("all")
    renderTab({ notificationLevel: "everything" })

    expect(screen.getByTestId("stream-push-summary")).toHaveTextContent("You'll get pushes for every message.")
  })

  it("flags quiet hours and this device in the result, and links them in the reasons", async () => {
    accountLevel("all", { quietOutsideWorkingHours: true })
    pushOnThisDevice({ permission: "denied", isSubscribed: false, status: "idle" })
    renderTab({ notificationLevel: null })

    expect(screen.getByTestId("stream-push-summary")).toHaveTextContent(
      "You'll get pushes for @mentions, during working hours, but not on this device."
    )
    await userEvent.click(screen.getByRole("button", { name: "Why" }))
    expect({
      quiet: screen.getByRole("link", { name: "working hours" }).getAttribute("href"),
      device: screen.getByRole("link", { name: "this device" }).getAttribute("href"),
    }).toEqual({
      quiet: `/w/${WS}/s/${CHANNEL.id}?settings=notifications&setting=quiet-hours`,
      device: `/w/${WS}/s/${CHANNEL.id}?settings=notifications&setting=push-device`,
    })
  })

  it("explains a system stream in the notify row instead of a loose note", () => {
    accountLevel("all")
    renderTab({ notificationLevel: null, stream: { ...CHANNEL, type: StreamTypes.SYSTEM, slug: null } as Stream })

    expect(screen.getByRole("radiogroup", { name: "Notify me about" })).toHaveAccessibleDescription(
      /Automated system messages\. It's read-only, so notifications are all there is to set\./
    )
  })
})
