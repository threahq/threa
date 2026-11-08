import { test, expect, type APIResponse } from "@playwright/test"
import {
  loginAndCreateWorkspace,
  expectApiOk,
  sendApiOk,
  createChannelViaApi,
  joinWorkspace,
  workspaceIdFromUrl,
} from "./helpers"

// Zero-height reaction events pad the window, as folded agent-run groups do in practice.

test.describe.configure({ timeout: 120_000 })
test.use({ viewport: { width: 412, height: 780 }, hasTouch: true, isMobile: true })

const REACTION_TOGGLES = 24

test("opening at the unread marker in a window that fits the viewport pages in older history", async ({
  page,
  browser,
}) => {
  const { testId } = await loginAndCreateWorkspace(page, "marker-short")
  const workspaceId = workspaceIdFromUrl(page)
  const streamId = await createChannelViaApi(page, workspaceId, `marker-short-${testId}`, "public")
  await expectApiOk(
    await page.request.patch(`/api/workspaces/${workspaceId}/preferences`, { data: { unreadOpenPosition: "marker" } }),
    "Set marker preference"
  )

  // The owner's read history, about to fall out of the latest window.
  const olderRes = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: { streamId, content: `older read ${testId}` },
  })
  await expectApiOk(olderRes, "Older message")
  const older = ((await olderRes.json()) as { message: { id: string } }).message
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/read`, {
      data: { lastMessageId: older.id },
    }),
    "Read the older message"
  )
  // Off the app while the rest lands, so the open is a cold one with no cached window.
  await page.goto("about:blank")

  const other = await joinWorkspace(browser, workspaceId, "marker-short-b", testId)
  const unreadIds: string[] = []
  try {
    await expectApiOk(
      await other.page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`, { data: {} }),
      "Second user joins the channel"
    )
    const postUnread = (n: number) =>
      other.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: `unread ${n} ${testId}` },
      })
    const messageId = async (res: APIResponse) => ((await res.json()) as { message: { id: string } }).message.id
    let first: APIResponse | undefined
    await expect
      .poll(async () => (first = await postUnread(1)).status(), {
        timeout: 10000,
        message: "second user's first post should be accepted after joining",
      })
      .toBe(201)
    const second = await sendApiOk(() => postUnread(2), "Second unread")
    unreadIds.push(await messageId(first!), await messageId(second))
    for (let i = 0; i < REACTION_TOGGLES; i++) {
      await expectApiOk(
        await other.page.request.post(`/api/workspaces/${workspaceId}/messages/${unreadIds[1]}/reactions`, {
          data: { emoji: "👍" },
        }),
        `Reaction ${i}`
      )
      await expectApiOk(
        await other.page.request.delete(
          `/api/workspaces/${workspaceId}/messages/${unreadIds[1]}/reactions/${encodeURIComponent("👍")}`
        ),
        `Unreaction ${i}`
      )
    }
  } finally {
    await other.context.close()
  }

  const bootstrapRes = await page.request.get(`/api/workspaces/${workspaceId}/streams/${streamId}/bootstrap`)
  await expectApiOk(bootstrapRes, "Bootstrap")
  const bootstrap = (await bootstrapRes.json()) as {
    data: { hasOlderEvents: boolean; events: Array<{ eventType: string; payload: { messageId?: string } }> }
  }
  const windowMessageIds = bootstrap.data.events
    .filter((event) => event.eventType === "message_created")
    .map((event) => event.payload.messageId)
  expect({ hasOlderEvents: bootstrap.data.hasOlderEvents, windowMessageIds }).toEqual({
    hasOlderEvents: true,
    windowMessageIds: unreadIds,
  })

  await page.goto(`/w/${workspaceId}/s/${streamId}`)
  const row = (text: string) => page.locator("main [data-message-id]").filter({ hasText: text }).first()
  await expect(row(`unread 1 ${testId}`)).toBeVisible({ timeout: 20000 })
  await expect(row(`older read ${testId}`)).toBeAttached({ timeout: 10000 })
})
