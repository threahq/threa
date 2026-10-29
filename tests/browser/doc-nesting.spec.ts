import { test, expect, type Locator, type Page } from "@playwright/test"
import type { DocSection } from "@threahq/types"
import {
  createChannelViaApi,
  createDocViaApi,
  expectApiOk,
  loginAndCreateWorkspace,
  pane,
  panesSettled,
  renameDoc,
  workspaceIdFromUrl,
} from "./helpers"

test.describe.configure({ timeout: 180_000 })

async function activate(locator: Locator, touch: boolean, timeout = 15000) {
  if (touch) await locator.tap({ timeout })
  else await locator.click({ timeout })
}

async function openAction(page: Page, streamId: string, name: string, touch: boolean) {
  await activate(pane(page, streamId).getByRole("button", { name: "Stream actions" }).first(), touch)
  await activate(page.getByRole(touch ? "button" : "menuitem", { name, exact: true }), touch)
}

async function navigateToAncestor(page: Page, fromId: string, ancestorId: string, label: string, touch: boolean) {
  const breadcrumb = pane(page, fromId).getByRole("navigation", { name: "breadcrumb" })
  const tabs = pane(page, fromId).getByRole("navigation", { name: "Panel tabs" })
  const directLink = breadcrumb
    .getByRole("link", { name: label, exact: true })
    .or(tabs.getByRole("link", { name: label, exact: true }))
  const overflow = breadcrumb.getByRole("button").or(tabs.getByRole("button", { name: /more tabs?/ }))
  const menuItem = page.getByRole("menuitem", { name: label, exact: true })
  await expect(async () => {
    await panesSettled(page)
    if (await menuItem.isVisible()) {
      await activate(menuItem, touch, 1000)
    } else if (await directLink.isVisible()) {
      await activate(directLink, touch, 1000)
    } else {
      await activate(overflow.first(), touch, 1000)
      await activate(menuItem, touch, 1000)
    }
  }).toPass({ timeout: 15000 })
  await expect(page.getByRole("menu")).toHaveCount(0)
  await expect(pane(page, ancestorId)).toBeVisible({ timeout: 15000 })
}

async function openHostedDoc(page: Page, hostId: string, title: string, touch: boolean) {
  await activate(pane(page, hostId).getByRole("button", { name: "1 doc" }), touch)
  await activate(page.getByRole("menuitem", { name: new RegExp(title) }), touch)
}

async function nestedDocJourney(page: Page, touch: boolean) {
  const { testId } = await loginAndCreateWorkspace(page, touch ? "doc-nesting-touch" : "doc-nesting")
  const workspaceId = workspaceIdFromUrl(page)
  const channelSlug = `private-${testId}`
  const channelId = await createChannelViaApi(page, workspaceId, channelSlug, "private")
  const parentId = await createDocViaApi(page, workspaceId, channelId)
  const parentTitle = `Parent ${testId}`
  await renameDoc(page, workspaceId, parentId, parentTitle)
  await page.goto(`/w/${workspaceId}/s/${parentId}`)

  const childTitle = `Child ${testId}`
  const childCreated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/workspaces/${workspaceId}/streams`
  )
  await openAction(page, parentId, "New doc", touch)
  const childResponse = await childCreated
  await expectApiOk(childResponse, "Create child doc from a channel-hosted doc")
  const child = (await childResponse.json()).stream as { id: string }
  expect(childResponse.request().postDataJSON()).toMatchObject({ type: "doc", parentStreamId: parentId })
  await renameDoc(page, workspaceId, child.id, childTitle)
  const childEditor = pane(page, child.id).locator(".ProseMirror")
  await expect(childEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
  const initialChildState = await page.request.get(`/api/workspaces/${workspaceId}/docs/${child.id}`)
  await expectApiOk(initialChildState, "Read child created under channel-hosted doc")
  expect((await initialChildState.json()).stream).toMatchObject({ parentStreamId: parentId, rootStreamId: channelId })

  await navigateToAncestor(page, child.id, parentId, parentTitle, touch)
  await expect(pane(page, parentId).getByRole("button", { name: "1 doc" })).toBeVisible()
  await openHostedDoc(page, parentId, childTitle, touch)
  await expect(childEditor).toHaveAttribute("contenteditable", "true")

  await childEditor.click()
  await page.keyboard.type(`/doc Grandchild ${testId}`)
  const grandchildCreate = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/workspaces/${workspaceId}/streams`
  )
  const newDocOption = page.getByRole("listbox", { name: "Doc suggestions" }).getByRole("option", { name: /New doc/ })
  await expect(newDocOption).toBeVisible({ timeout: 10000 })
  await page.keyboard.press("Enter")
  const grandchildResponse = await grandchildCreate
  await expectApiOk(grandchildResponse, "Create grandchild from child editor")
  const grandchild = (await grandchildResponse.json()).stream as { id: string }
  const grandchildTitle = `Grandchild ${testId}`
  expect(grandchildResponse.request().postDataJSON()).toMatchObject({ type: "doc", parentStreamId: child.id })
  const grandchildEditor = pane(page, grandchild.id).locator(".ProseMirror")
  await expect(grandchildEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
  const initialGrandchildState = await page.request.get(`/api/workspaces/${workspaceId}/docs/${grandchild.id}`)
  await expectApiOk(initialGrandchildState, "Read grandchild created under child doc")
  expect((await initialGrandchildState.json()).stream).toMatchObject({
    parentStreamId: child.id,
    rootStreamId: channelId,
  })
  await navigateToAncestor(page, grandchild.id, child.id, childTitle, touch)
  await expect(pane(page, child.id).getByRole("button", { name: "1 doc" })).toBeVisible()
  await expect(pane(page, child.id).locator(".ProseMirror [data-type='doc-chip']")).toContainText(grandchildTitle)

  const destinationCreated = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "doc" },
  })
  await expectApiOk(destinationCreated, "Create top-level destination doc")
  const destinationId = ((await destinationCreated.json()) as { stream: { id: string } }).stream.id
  const destinationTitle = `Destination ${testId}`
  await renameDoc(page, workspaceId, destinationId, destinationTitle)
  await openAction(page, child.id, "Move to…", touch)
  const moveDialog = page.getByRole("dialog", { name: `Move ${childTitle} to…` })
  await moveDialog.getByPlaceholder("Search streams…").fill(destinationTitle)
  const moveResponsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/move")
  )
  await activate(moveDialog.getByRole("option", { name: destinationTitle }), touch)
  const moveResponse = await moveResponsePromise
  await expectApiOk(moveResponse, "Move nested doc subtree")
  expect(moveResponse.request().postDataJSON()).toMatchObject({ fromStreamId: parentId, toStreamId: destinationId })
  await expect(page.getByRole("heading", { name: "Change who can read this doc?" })).toHaveCount(0)

  const childState = await page.request.get(`/api/workspaces/${workspaceId}/docs/${child.id}`)
  await expectApiOk(childState, "Read moved child")
  expect((await childState.json()).stream).toMatchObject({ parentStreamId: destinationId, rootStreamId: destinationId })
  const grandchildState = await page.request.get(`/api/workspaces/${workspaceId}/docs/${grandchild.id}`)
  await expectApiOk(grandchildState, "Read moved grandchild")
  expect((await grandchildState.json()).stream).toMatchObject({ parentStreamId: child.id, rootStreamId: destinationId })

  await navigateToAncestor(page, child.id, destinationId, destinationTitle, touch)
  await expect(pane(page, destinationId).getByRole("button", { name: "1 doc" })).toBeVisible({ timeout: 15000 })
  await openHostedDoc(page, destinationId, childTitle, touch)
  await expect(childEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
  await expect(pane(page, child.id).getByRole("button", { name: "1 doc" })).toBeVisible({ timeout: 15000 })
  await openHostedDoc(page, child.id, grandchildTitle, touch)
  await expect(grandchildEditor).toBeVisible({ timeout: 15000 })
  await expect(grandchildEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
  await navigateToAncestor(page, grandchild.id, child.id, childTitle, touch)

  if (touch) await activate(pane(page, child.id).getByRole("button", { name: /sidebar/i }), touch)
  const channelLink = page
    .getByRole("navigation", { name: "Sidebar navigation" })
    .getByRole("link", { name: "#" + channelSlug, exact: true })
  await activate(channelLink, touch)
  await expect(pane(page, channelId)).toBeVisible({ timeout: 15000 })
  await openHostedDoc(page, channelId, parentTitle, touch)
  await expect(pane(page, parentId)).toBeVisible({ timeout: 15000 })
  await expect(pane(page, parentId).getByRole("button", { name: "1 doc" })).toHaveCount(0)
  if (touch) await activate(pane(page, parentId).getByRole("button", { name: /sidebar/i }), touch)
  await activate(
    page.getByRole("navigation", { name: "Sidebar navigation" }).getByRole("link", { name: "Docs", exact: true }),
    touch
  )
  await activate(
    page.getByRole("listitem").getByRole("link", { name: new RegExp(`^${destinationTitle}`), disabled: false }),
    touch
  )
  await openHostedDoc(page, destinationId, childTitle, touch)
  await expect(childEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })

  await openAction(page, child.id, "Move to…", touch)
  const liftDialog = page.getByRole("dialog", { name: `Move ${childTitle} to…` })
  await activate(liftDialog.getByRole("button", { name: "Top level" }), touch)
  await activate(liftDialog.getByRole("button", { name: /^Private/ }), touch)
  const liftResponsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/move")
  )
  await activate(liftDialog.getByRole("button", { name: "Move", exact: true }), touch)
  const liftResponse = await liftResponsePromise
  await expectApiOk(liftResponse, "Lift child doc subtree")
  expect(liftResponse.request().postDataJSON()).toMatchObject({ fromStreamId: destinationId, toStreamId: null })
  await expect(page.getByRole("heading", { name: "Change who can read this doc?" })).toHaveCount(0)

  const liftedState = await page.request.get(`/api/workspaces/${workspaceId}/docs/${child.id}`)
  await expectApiOk(liftedState, "Read lifted child")
  expect((await liftedState.json()).stream).toMatchObject({ parentStreamId: null, rootStreamId: null })
  const liftedGrandchild = await page.request.get(`/api/workspaces/${workspaceId}/docs/${grandchild.id}`)
  await expectApiOk(liftedGrandchild, "Read grandchild after lift")
  expect((await liftedGrandchild.json()).stream).toMatchObject({ parentStreamId: child.id, rootStreamId: child.id })

  await expect(pane(page, child.id).getByRole("button", { name: "1 doc" })).toBeVisible({ timeout: 15000 })
  const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin)
  await openHostedDoc(page, child.id, grandchildTitle, touch)
  await expect(grandchildEditor).toBeVisible({ timeout: 15000 })
  await expect(grandchildEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentTimeOrigin)
  await grandchildEditor.click()
  await page.keyboard.type(`Live edit ${testId}`)
  await expect(grandchildEditor).toContainText(`Live edit ${testId}`)
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/workspaces/${workspaceId}/docs/${grandchild.id}`)
      await expectApiOk(response, "Read grandchild live edit after lift")
      const { sections } = (await response.json()) as { sections: DocSection[] }
      return sections.map((section) => section.markdown).join("\n")
    })
    .toContain(`Live edit ${testId}`)
}

test("should create, rehost, lift and open a nested-doc subtree on desktop", async ({ page }) => {
  await nestedDocJourney(page, false)
})

test.describe("nested docs on touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test("should create, rehost, lift and open a nested-doc subtree on touch", async ({ page }) => {
    await nestedDocJourney(page, true)
  })
})
