import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, expectApiOk } from "./helpers"

test.use({ permissions: ["clipboard-read", "clipboard-write"] })

test("probe paste-as-plain-text", async ({ page }) => {
  await loginAndCreateWorkspace(page, "plainpaste")
  const workspaceId = page.url().match(/\/w\/([^/]+)/)?.[1] ?? ""
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, { data: { type: "scratchpad" } })
  await expectApiOk(response, "Create scratchpad")
  const streamId = ((await response.json()) as { stream: { id: string } }).stream.id
  await page.goto(`/w/${workspaceId}/s/${streamId}`)

  const editor = page.getByRole("main").locator("[contenteditable='true']").first()
  await expect(editor).toBeVisible({ timeout: 10000 })

  await editor.click()
  await page.evaluate(() => {
    const target = document.querySelector("main [contenteditable='true']")
    if (!target) throw new Error("Editor not found")
    const clipboardData = new DataTransfer()
    clipboardData.setData("text/plain", "**bold words** tail")
    target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }))
  })
  await expect(editor.locator("strong")).toHaveText("bold words")

  await page.evaluate(() => {
    const target = document.querySelector("main [contenteditable='true']") as HTMLElement
    const log: unknown[] = []
    ;(window as unknown as { __log: unknown[] }).__log = log
    target.addEventListener(
      "paste",
      (event) => {
        const clipboardEvent = event as ClipboardEvent
        log.push({
          kind: "paste",
          types: [...(clipboardEvent.clipboardData?.types ?? [])],
          text: clipboardEvent.clipboardData?.getData("text/plain"),
          htmlLength: (clipboardEvent.clipboardData?.getData("text/html") ?? "").length,
        })
      },
      true
    )
    target.addEventListener(
      "beforeinput",
      (event) => {
        const inputEvent = event as InputEvent
        log.push({
          kind: "beforeinput",
          inputType: inputEvent.inputType,
          data: inputEvent.data,
          dtTypes: [...(inputEvent.dataTransfer?.types ?? [])],
          dtText: inputEvent.dataTransfer?.getData("text/plain"),
        })
      },
      true
    )
    target.addEventListener(
      "keydown",
      (event) => {
        const keyboardEvent = event as KeyboardEvent
        log.push({ kind: "keydown", key: keyboardEvent.key, shift: keyboardEvent.shiftKey })
      },
      true
    )
  })

  // Select the whole bold run, copy it for real, collapse, then paste as plain text.
  await page.evaluate(() => {
    const target = document.querySelector("main [contenteditable='true']")
    if (!target) throw new Error("Editor not found")
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const index = (node.textContent ?? "").indexOf("bold words")
      if (index === -1) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + "bold words".length)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      ;(target as HTMLElement).focus()
      return
    }
    throw new Error("not found")
  })
  await page.keyboard.press("Control+c")
  console.log("CLIPBOARD:", JSON.stringify(await page.evaluate(() => navigator.clipboard.readText())))

  await page.keyboard.press("ArrowRight")
  await page.waitForFunction(() => window.getSelection()?.isCollapsed === true)
  await page.keyboard.press("Control+Shift+v")
  await page.waitForTimeout(700)

  console.log("LOG:", JSON.stringify(await page.evaluate(() => (window as unknown as { __log: unknown[] }).__log)))
  console.log("EDITOR TEXT:", JSON.stringify(await editor.innerText()))
})
