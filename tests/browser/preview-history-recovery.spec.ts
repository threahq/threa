import { test, expect, type Page } from "@playwright/test"
import { STREAM_PREVIEW_HISTORY_MAX_STREAMS } from "../../packages/types/src/api"
import { currentAccount, expectApiOk, loginAndCreateWorkspace, loginInNewContext } from "./helpers"

async function createChannel(page: Page, workspaceId: string, slug: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "channel", slug, visibility: "public" },
  })
  await expectApiOk(response, "Create preview channel")
  return (await response.json()).stream.id
}

async function send(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: { streamId, content },
  })
  await expectApiOk(response, "Send preview message")
  return (await response.json()).message.id
}

async function localState(page: Page, accountId: string, workspaceId: string) {
  return page.evaluate(
    ({ accountId, workspaceId }) =>
      new Promise<{
        messages: Array<{ streamId: string; content: string; deleted: boolean }>
        unreadCounts: Record<string, number>
        memberships: Array<{ streamId: string; notificationLevel: string | null }>
      }>((resolve, reject) => {
        const request = indexedDB.open(`threa_v2_${accountId}`)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            ["eventsByWorkspace", "unreadState", "streamMemberships"],
            "readonly"
          )
          const events = transaction.objectStore("eventsByWorkspace").getAll()
          const unread = transaction.objectStore("unreadState").get(workspaceId)
          const memberships = transaction.objectStore("streamMemberships").getAll()
          transaction.onerror = () => {
            database.close()
            reject(transaction.error)
          }
          transaction.oncomplete = () => {
            database.close()
            resolve({
              messages: events.result
                .filter((event) => event.workspaceId === workspaceId && event.eventType === "message_created")
                .map((event) => ({
                  streamId: event.streamId,
                  content: event.payload.contentMarkdown ?? "",
                  deleted: !!event.payload.deletedAt,
                })),
              unreadCounts: unread.result?.unreadCounts ?? {},
              memberships: memberships.result.map((membership) => ({
                streamId: membership.streamId,
                notificationLevel: membership.notificationLevel,
              })),
            })
          }
        }
      }),
    { accountId, workspaceId }
  )
}

test("should keep every unopened preview available offline and batch recovery without gating sidebar metadata on hover", async ({
  browser,
  page,
  context,
}) => {
  test.setTimeout(120_000)
  const owner = await loginAndCreateWorkspace(page, "preview-recovery")
  const workspaceId = page.url().match(/\/w\/([^/?]+)/)![1]
  const accountId = (await currentAccount(page)).id
  const streams = await Promise.all(
    Array.from({ length: 4 }, (_, index) => createChannel(page, workspaceId, `preview-${index}-${owner.testId}`))
  )
  const current = await createChannel(page, workspaceId, `current-${owner.testId}`)
  for (const [index, streamId] of streams.entries()) await send(page, workspaceId, streamId, `Cached preview ${index}`)
  const edited = await send(page, workspaceId, streams[0], "Before offline edit")
  const deleted = await send(page, workspaceId, streams[0], "Before offline deletion")

  const batches: string[][] = []
  const individualPreviewFetches: string[] = []
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname
    if (request.method() === "POST" && pathname.endsWith("/streams/preview-history")) {
      batches.push(request.postDataJSON().streamIds)
    }
    if (request.method() === "GET" && streams.some((id) => pathname.endsWith(`/streams/${id}/bootstrap`))) {
      individualPreviewFetches.push(pathname)
    }
  })
  const initialPreviews = page.waitForResponse((response) => {
    const request = response.request()
    return (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/streams/preview-history") &&
      streams.every((id) => request.postDataJSON().streamIds.includes(id))
    )
  })
  await page.goto(`/w/${workspaceId}/s/${current}`)
  const initialPreviewResponse = await initialPreviews
  await expectApiOk(initialPreviewResponse, "Warm initial preview histories")
  await initialPreviewResponse.finished()
  await expect(page.getByRole("main").locator("[contenteditable='true']").first()).toBeVisible()
  await expect
    .poll(async () => (await localState(page, accountId, workspaceId)).messages.map((message) => message.content))
    .toEqual(
      expect.arrayContaining([
        ...streams.map((_, index) => `Cached preview ${index}`),
        "Before offline edit",
        "Before offline deletion",
      ])
    )
  await context.setOffline(true)
  const sidebar = page.getByRole("navigation", { name: "Sidebar navigation" })
  for (const [index, streamId] of streams.entries()) {
    await sidebar.locator(`a[href$='/s/${streamId}']`).first().hover()
    const card = page
      .locator("[data-radix-popper-content-wrapper]")
      .filter({ hasText: `preview-${index}-${owner.testId}` })
    await expect(card.getByText(`Cached preview ${index}`, { exact: true })).toBeVisible()
    await page.mouse.move(900, 700)
    await expect(card).toHaveCount(0)
  }

  const settings = await loginInNewContext(browser, owner.email, owner.name)
  const sender = await loginInNewContext(browser, `preview-sender-${owner.testId}@example.com`, "Preview Sender")
  try {
    await expectApiOk(
      await sender.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, { data: { role: "member" } }),
      "Sender joins workspace"
    )
    for (const streamId of streams.slice(0, 2)) {
      await expectApiOk(
        await sender.page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`, { data: {} }),
        "Sender joins preview channel"
      )
    }
    const renamed = `renamed-${owner.testId}`
    await expectApiOk(
      await settings.page.request.patch(`/api/workspaces/${workspaceId}/streams/${streams[0]}`, {
        data: { slug: renamed },
      }),
      "Rename preview while offline"
    )
    await expectApiOk(
      await settings.page.request.post(`/api/workspaces/${workspaceId}/streams/${streams[1]}/notification-level`, {
        data: { notificationLevel: "muted" },
      }),
      "Mute preview while offline"
    )
    await expectApiOk(
      await settings.page.request.patch(`/api/workspaces/${workspaceId}/sidebar-config`, {
        data: {
          basePreset: "all",
          sections: [
            { id: "filed", spec: { kind: "custom", sectionId: "filed", name: "Filed", streamIds: [streams[0]] } },
            { id: "channels", spec: { kind: "type", streamType: "channel" } },
          ],
        },
      }),
      "Move preview to a sidebar section while offline"
    )
    await expectApiOk(
      await settings.page.request.patch(`/api/workspaces/${workspaceId}/messages/${edited}`, {
        data: { content: "Edited while offline" },
      }),
      "Edit cached preview while offline"
    )
    await expectApiOk(
      await settings.page.request.delete(`/api/workspaces/${workspaceId}/messages/${deleted}`),
      "Delete cached preview while offline"
    )
    await send(sender.page, workspaceId, streams[0], "Missed preview A")
    await send(sender.page, workspaceId, streams[1], "Missed preview B")
    batches.length = 0
    individualPreviewFetches.length = 0
    await context.setOffline(false)

    const filed = sidebar.locator("div.mb-4", { has: page.getByRole("heading", { name: "Filed", level: 3 }) })
    const renamedRow = filed.locator(`a[href$='/s/${streams[0]}']`)
    await expect(renamedRow).toContainText(renamed, { timeout: 20_000 })
    await expect(renamedRow).toContainText("Missed preview A")
    await expect(sidebar.locator(`a[href$='/s/${streams[1]}']`).first()).toContainText("Missed preview B")
    await expect
      .poll(
        async () => {
          const state = await localState(page, accountId, workspaceId)
          return {
            counts: [state.unreadCounts[streams[0]], state.unreadCounts[streams[1]]],
            muted: state.memberships.find((membership) => membership.streamId === streams[1])?.notificationLevel,
            edited: state.messages.some((message) => message.content === "Edited while offline"),
            deletedVisible: state.messages.some(
              (message) => message.content === "Before offline deletion" && !message.deleted
            ),
          }
        },
        { timeout: 20_000 }
      )
      .toEqual({ counts: [1, 1], muted: "muted", edited: true, deletedVisible: false })

    for (const [index, streamId] of streams.slice(0, 2).entries()) {
      await sidebar.locator(`a[href$='/s/${streamId}']`).first().hover()
      const card = page
        .locator("[data-radix-popper-content-wrapper]")
        .filter({ hasText: index === 0 ? renamed : `preview-1-${owner.testId}` })
      await expect(card.getByText(index === 0 ? "Missed preview A" : "Missed preview B", { exact: true })).toBeVisible()
      if (index === 0) {
        await expect(card.getByText("Edited while offline", { exact: true })).toBeVisible()
        await expect(card.getByText("Before offline deletion", { exact: true })).toHaveCount(0)
      }
      await page.mouse.move(900, 700)
      await expect(card).toHaveCount(0)
    }
    expect(individualPreviewFetches).toEqual([])
    expect(batches.flat()).toEqual(expect.arrayContaining(streams))
    expect(batches.every((batch) => batch.length <= STREAM_PREVIEW_HISTORY_MAX_STREAMS)).toBe(true)
    expect(batches.length).toBeLessThan(streams.length)

    await sidebar.locator(`a[href$='/s/${streams[1]}']`).first().click({ button: "right" })
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
    await expect(page.getByRole("dialog").getByRole("combobox").first()).toContainText("Muted")
  } finally {
    await settings.context.close()
    await sender.context.close()
  }
})
