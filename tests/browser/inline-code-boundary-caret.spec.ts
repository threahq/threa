import { expect, test, type Page } from "@playwright/test"
import { openComposerFixture } from "./helpers"

type BoundaryTarget = "outside-start" | "inside-start" | "inside-end" | "outside-end"

interface BoundarySelectionMetrics {
  caretColor: string
  effectiveCaretLeft: number | null
  nativeCaretRect: {
    height: number
    left: number
    top: number
  } | null
  overlayPresent: boolean
  overlayColor: string | null
  overlayRect: {
    height: number
    left: number
    top: number
  } | null
  referenceCaretLefts: {
    insideEnd: number | null
    insideStart: number | null
    outsideEnd: number | null
    outsideStart: number | null
  }
  selection: {
    anchorOffset: number | null
    anchorText: string | null
    location: "after" | "before" | "code" | "parent" | "unknown"
  } | null
}

const inlineCodeNavigationStates = [
  "|a [code] b",
  "a| [code] b",
  "a |[code] b",
  "a [|code] b",
  "a [c|ode] b",
  "a [co|de] b",
  "a [cod|e] b",
  "a [code|] b",
  "a [code]| b",
  "a [code] |b",
  "a [code] b|",
] as const

async function setComposerContent(page: Page, blockType: "paragraph" | "heading", level?: 1 | 3) {
  const editor = page.locator("[contenteditable='true']")

  await editor.click()

  await page.evaluate(
    ({ blockType, level }) => {
      const editorElement = document.querySelector<HTMLElement>("[contenteditable='true']")
      const editor = editorElement?.editor

      if (!editor) {
        throw new Error("Editor not found")
      }

      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: blockType,
            ...(blockType === "heading" ? { attrs: { level } } : {}),
            content: [
              { type: "text", text: "a " },
              { type: "text", text: "code", marks: [{ type: "code" }] },
              { type: "text", text: " b" },
            ],
          },
        ],
      })

      editor.commands.focus("start")
    },
    { blockType, level }
  )

  await expect(editor.locator("code")).toHaveText("code")
  await expect
    .poll(() =>
      page.evaluate(() => {
        const editorElement = document.querySelector<HTMLElement>("[contenteditable='true']")
        return editorElement?.firstElementChild?.tagName.toLowerCase() ?? null
      })
    )
    .toBe(blockType === "paragraph" ? "p" : `h${level}`)
}

async function setInlineCodeBoundaryState(page: Page, target: BoundaryTarget) {
  await page.evaluate((value: BoundaryTarget) => {
    const editorElement = document.querySelector<HTMLElement>("[contenteditable='true']")
    const editor = editorElement?.editor

    if (!editor) {
      throw new Error("Editor not found")
    }

    let codeStart: number | null = null
    let codeEnd: number | null = null

    editor.state.doc.descendants(
      (node: { isText: boolean; marks?: Array<{ type: { name: string } }>; text?: string }, pos: number) => {
        if (!node.isText || !node.text || !node.marks?.some((mark) => mark.type.name === "code")) {
          return
        }

        codeStart = pos
        codeEnd = pos + node.text.length
        return false
      }
    )

    if (codeStart === null || codeEnd === null) {
      throw new Error("Inline code range not found")
    }

    const boundaryPos = value === "outside-start" || value === "inside-start" ? codeStart : codeEnd
    const marks = value === "inside-start" || value === "inside-end" ? [editor.state.schema.marks.code.create()] : []

    editor.commands.setTextSelection(boundaryPos)
    editor.view.dispatch(editor.state.tr.setStoredMarks(marks))
    editor.view.focus()
  }, target)
}

async function focusInlineCodeNavigationStart(page: Page) {
  await page.evaluate(() => {
    const editorElement = document.querySelector<HTMLElement>("[contenteditable='true']")
    const editor = editorElement?.editor

    if (!editor) {
      throw new Error("Editor not found")
    }

    editor.commands.focus("start")
    // Tiptap's focus() calls view.focus() in its next animation frame, which writes the PM
    // selection back into the DOM; a key pressed before that frame can be reverted by it.
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  await expect(page.locator("[contenteditable='true']")).toBeFocused()
}

async function focusInlineCodeNavigationEnd(page: Page) {
  await page.evaluate(() => {
    const editorElement = document.querySelector<HTMLElement>("[contenteditable='true']")
    const editor = editorElement?.editor

    if (!editor) {
      throw new Error("Editor not found")
    }

    editor.commands.focus("end")
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  await expect(page.locator("[contenteditable='true']")).toBeFocused()
}

async function getBoundarySelectionMetrics(page: Page): Promise<BoundarySelectionMetrics> {
  return page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>("[contenteditable='true']")
    const code = editor?.querySelector<HTMLElement>("code")
    const overlay = document.querySelector<HTMLElement>("[data-inline-code-boundary-overlay='true']")
    const overlayVisible = overlay != null && getComputedStyle(overlay).display !== "none"
    const selection = window.getSelection()

    if (!editor || !code) {
      throw new Error("Editor or inline code not found")
    }

    const beforeNode = code.previousSibling instanceof Text ? code.previousSibling : null
    const afterNode = code.nextSibling instanceof Text ? code.nextSibling : null

    let location: "after" | "before" | "code" | "parent" | "unknown" = "unknown"
    if (selection?.anchorNode === beforeNode) {
      location = "before"
    } else if (selection?.anchorNode === afterNode) {
      location = "after"
    } else if (selection?.anchorNode && code.contains(selection.anchorNode)) {
      location = "code"
    } else if (selection?.anchorNode === code.parentNode) {
      location = "parent"
    }

    const textNodes: Text[] = []
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
    let current: Node | null

    while ((current = walker.nextNode())) {
      if ((current.textContent?.length ?? 0) > 0) {
        textNodes.push(current as Text)
      }
    }

    const measureCollapsedCaretRect = (node: Node, offset: number) => {
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset)

      const rect = range.getBoundingClientRect()
      if (rect.height > 0) {
        return {
          left: rect.left,
          top: rect.top,
          height: rect.height,
        }
      }

      const fallbackRect = range.getClientRects()[0]
      if (!fallbackRect || fallbackRect.height <= 0) {
        return null
      }

      return {
        left: fallbackRect.left,
        top: fallbackRect.top,
        height: fallbackRect.height,
      }
    }

    const nativeRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    const nativeCaretRect = nativeRange
      ? measureCollapsedCaretRect(nativeRange.startContainer, nativeRange.startOffset)
      : null

    const overlayRect = overlayVisible
      ? (() => {
          const rect = overlay!.getBoundingClientRect()
          return {
            left: rect.left,
            top: rect.top,
            height: rect.height,
          }
        })()
      : null

    const firstTextNode = textNodes[0]
    const lastTextNode = textNodes[textNodes.length - 1]
    const codeRect = code.getBoundingClientRect()
    const outsideEndRect =
      afterNode instanceof Text
        ? measureCollapsedCaretRect(afterNode, 0)
        : code.parentNode
          ? measureCollapsedCaretRect(
              code.parentNode,
              Math.max(0, Array.prototype.indexOf.call(code.parentNode.childNodes, code) + 1)
            )
          : null

    return {
      caretColor: getComputedStyle(editor).caretColor,
      effectiveCaretLeft: overlayRect?.left ?? nativeCaretRect?.left ?? null,
      nativeCaretRect,
      overlayPresent: overlayVisible,
      overlayColor: overlayVisible ? getComputedStyle(overlay!).borderLeftColor : null,
      overlayRect,
      referenceCaretLefts: {
        outsideStart: codeRect.left,
        insideStart: firstTextNode ? (measureCollapsedCaretRect(firstTextNode, 0)?.left ?? null) : null,
        insideEnd: lastTextNode ? (measureCollapsedCaretRect(lastTextNode, lastTextNode.length)?.left ?? null) : null,
        outsideEnd: outsideEndRect?.left ?? codeRect.right,
      },
      selection: selection
        ? {
            location,
            anchorText: selection.anchorNode?.textContent ?? null,
            anchorOffset: selection.anchorOffset,
          }
        : null,
    }
  })
}

async function expectBoundarySelection(page: Page, target: BoundaryTarget) {
  const metrics = await getBoundarySelectionMetrics(page)
  expect(metrics.effectiveCaretLeft).not.toBeNull()

  const expectedLeftByTarget = {
    "outside-start": metrics.referenceCaretLefts.outsideStart,
    "inside-start": metrics.referenceCaretLefts.insideStart,
    "inside-end": metrics.referenceCaretLefts.insideEnd,
    "outside-end": metrics.referenceCaretLefts.outsideEnd,
  } as const

  const expectedLeft = expectedLeftByTarget[target]

  expect(expectedLeft).not.toBeNull()
  expect(Math.abs((metrics.effectiveCaretLeft ?? 0) - (expectedLeft ?? 0))).toBeLessThan(1.25)

  switch (target) {
    case "outside-start":
      expect(metrics.overlayPresent).toBe(false)
      expect(metrics.caretColor).not.toBe("transparent")
      break
    case "inside-start":
      expect(metrics.overlayPresent).toBe(true)
      expect(metrics.caretColor === "transparent" || /^rgba?\([^)]*,\s*0\)$/.test(metrics.caretColor)).toBe(true)
      expect(metrics.overlayColor === null || !/^rgba?\([^)]*,\s*0\)$/.test(metrics.overlayColor)).toBe(true)
      break
    case "inside-end":
      expect(metrics.overlayPresent).toBe(false)
      expect(metrics.caretColor).not.toBe("transparent")
      break
    case "outside-end":
      expect(metrics.overlayPresent).toBe(true)
      expect(metrics.caretColor === "transparent" || /^rgba?\([^)]*,\s*0\)$/.test(metrics.caretColor)).toBe(true)
      expect(metrics.overlayColor === null || !/^rgba?\([^)]*,\s*0\)$/.test(metrics.overlayColor)).toBe(true)
      break
  }
}

async function getInlineCodeNavigationSnapshot(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editorElement = document.querySelector<HTMLElement>("[contenteditable='true']")
    const editor = editorElement?.editor

    if (!editor) {
      throw new Error("Editor not found")
    }

    const segments: Array<{
      end: number
      isCode: boolean
      start: number
      text: string
    }> = []

    editor.state.doc.descendants(
      (node: { isText: boolean; text?: string; marks?: Array<{ type: { name: string } }> }, pos: number) => {
        if (!node.isText || !node.text) {
          return
        }

        segments.push({
          text: node.text,
          start: pos,
          end: pos + node.text.length,
          isCode: node.marks?.some((mark) => mark.type.name === "code") ?? false,
        })
      }
    )

    const codeSegment = segments.find((segment) => segment.isCode)
    if (!codeSegment) {
      throw new Error("Inline code segment not found")
    }

    const beforeSegments = segments.filter((segment) => segment.end <= codeSegment.start)
    const afterSegments = segments.filter((segment) => segment.start >= codeSegment.end)
    const beforeText = beforeSegments.map((segment) => segment.text).join("")
    const codeText = codeSegment.text
    const afterText = afterSegments.map((segment) => segment.text).join("")
    const cursorPos = editor.state.selection.from
    const insideCode = (editor.state.storedMarks ?? editor.state.selection.$from.marks()).some(
      (mark: { type: { name: string } }) => mark.type.name === "code"
    )

    const plainOffsetForSegments = (
      targetSegments: Array<{ end: number; start: number; text: string }>,
      pos: number
    ) => {
      let offset = 0

      for (const segment of targetSegments) {
        if (pos < segment.start) {
          return offset
        }

        if (pos <= segment.end) {
          return offset + (pos - segment.start)
        }

        offset += segment.text.length
      }

      return offset
    }

    const insertCaret = (text: string, offset: number) => `${text.slice(0, offset)}|${text.slice(offset)}`

    if (cursorPos < codeSegment.start || (cursorPos === codeSegment.start && !insideCode)) {
      return insertCaret(`${beforeText}[${codeText}]${afterText}`, plainOffsetForSegments(beforeSegments, cursorPos))
    }

    if (cursorPos > codeSegment.end || (cursorPos === codeSegment.end && !insideCode)) {
      return insertCaret(
        `${beforeText}[${codeText}]${afterText}`,
        beforeText.length + codeText.length + 2 + plainOffsetForSegments(afterSegments, cursorPos)
      )
    }

    return `${beforeText}[${insertCaret(codeText, cursorPos - codeSegment.start)}]${afterText}`
  })
}

async function expectNavigationSnapshot(page: Page, snapshot: string) {
  await expect.poll(() => getInlineCodeNavigationSnapshot(page)).toBe(snapshot)
}

async function getEffectiveCaretLeft(page: Page) {
  const metrics = await getBoundarySelectionMetrics(page)
  if (metrics.effectiveCaretLeft == null) {
    throw new Error("Caret is not visible")
  }

  return metrics.effectiveCaretLeft
}

test.describe("Inline code boundary caret", () => {
  test.beforeEach(({ page }) => openComposerFixture(page))

  for (const scenario of [
    { label: "paragraph", blockType: "paragraph" as const },
    { label: "h1", blockType: "heading" as const, level: 1 as const },
    { label: "h3", blockType: "heading" as const, level: 3 as const },
  ]) {
    test(`anchors the native caret to inline code boundaries in ${scenario.label}`, async ({ page }) => {
      await setComposerContent(page, scenario.blockType, scenario.level)

      for (const target of ["outside-start", "inside-start", "inside-end", "outside-end"] as const) {
        await setInlineCodeBoundaryState(page, target)
        await expectBoundarySelection(page, target)
      }
    })
  }

  test("walks every native caret stop from left to right through inline code", async ({ page }) => {
    await setComposerContent(page, "paragraph")
    await focusInlineCodeNavigationStart(page)

    await expectNavigationSnapshot(page, inlineCodeNavigationStates[0])

    for (let index = 1; index < inlineCodeNavigationStates.length; index += 1) {
      await page.keyboard.press("ArrowRight")
      await expectNavigationSnapshot(page, inlineCodeNavigationStates[index])

      if (index === 2) {
        await expectBoundarySelection(page, "outside-start")
      } else if (index === 3) {
        await expectBoundarySelection(page, "inside-start")
      } else if (index === 7) {
        await expectBoundarySelection(page, "inside-end")
      } else if (index === 8) {
        await expectBoundarySelection(page, "outside-end")
      }
    }
  })

  test("moves the painted caret forward at every logical step through inline code", async ({ page }) => {
    await setComposerContent(page, "paragraph")
    await focusInlineCodeNavigationStart(page)
    await expectNavigationSnapshot(page, inlineCodeNavigationStates[0])

    let previousLeft = await getEffectiveCaretLeft(page)

    for (let index = 1; index < inlineCodeNavigationStates.length; index += 1) {
      await page.keyboard.press("ArrowRight")
      await expectNavigationSnapshot(page, inlineCodeNavigationStates[index])

      const currentLeft = await getEffectiveCaretLeft(page)
      expect(currentLeft - previousLeft).toBeGreaterThan(0.5)
      previousLeft = currentLeft
    }
  })

  test("walks every native caret stop from right to left through inline code", async ({ page }) => {
    await setComposerContent(page, "paragraph")
    await focusInlineCodeNavigationEnd(page)

    await expectNavigationSnapshot(page, inlineCodeNavigationStates[inlineCodeNavigationStates.length - 1])

    for (let index = inlineCodeNavigationStates.length - 2; index >= 0; index -= 1) {
      await page.keyboard.press("ArrowLeft")
      await expectNavigationSnapshot(page, inlineCodeNavigationStates[index])

      if (index === 8) {
        await expectBoundarySelection(page, "outside-end")
      } else if (index === 7) {
        await expectBoundarySelection(page, "inside-end")
      } else if (index === 3) {
        await expectBoundarySelection(page, "inside-start")
      } else if (index === 2) {
        await expectBoundarySelection(page, "outside-start")
      }
    }
  })

  test("moves the painted caret backward at every logical step through inline code", async ({ page }) => {
    await setComposerContent(page, "paragraph")
    await focusInlineCodeNavigationEnd(page)
    await expectNavigationSnapshot(page, inlineCodeNavigationStates[inlineCodeNavigationStates.length - 1])

    let previousLeft = await getEffectiveCaretLeft(page)

    for (let index = inlineCodeNavigationStates.length - 2; index >= 0; index -= 1) {
      await page.keyboard.press("ArrowLeft")
      await expectNavigationSnapshot(page, inlineCodeNavigationStates[index])

      const currentLeft = await getEffectiveCaretLeft(page)
      expect(previousLeft - currentLeft).toBeGreaterThan(0.5)
      previousLeft = currentLeft
    }
  })

  test("keeps the synthetic outside-end caret on the last wrapped line when inline code ends a block", async ({
    page,
  }) => {
    const metrics = await page.evaluate(async () => {
      const editorElement = document.querySelector<HTMLElement>("[contenteditable='true']")
      const editor = editorElement?.editor

      if (!editorElement || !editor) {
        throw new Error("Editor not found")
      }

      editorElement.style.width = "220px"
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "prefix " },
              { type: "text", text: "verylonginlinecodewordthatshouldwrapattheend", marks: [{ type: "code" }] },
            ],
          },
        ],
      })

      let codeEnd: number | null = null
      editor.state.doc.descendants(
        (node: { isText: boolean; marks?: Array<{ type: { name: string } }>; text?: string }, pos: number) => {
          if (!node.isText || !node.text || !node.marks?.some((mark) => mark.type.name === "code")) {
            return
          }

          codeEnd = pos + node.text.length
          return false
        }
      )

      if (codeEnd === null) {
        throw new Error("Inline code range not found")
      }

      editor.commands.setTextSelection(codeEnd)
      editor.view.dispatch(editor.state.tr.setStoredMarks([]))
      editor.view.focus()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

      const code = editorElement.querySelector<HTMLElement>("code")
      const overlay = document.querySelector<HTMLElement>("[data-inline-code-boundary-overlay='true']")
      const codeTextNode = code?.firstChild

      if (!code || !(codeTextNode instanceof Text) || !overlay) {
        throw new Error("Wrapped inline code geometry missing")
      }

      const endRange = document.createRange()
      endRange.setStart(codeTextNode, codeTextNode.length)
      endRange.setEnd(codeTextNode, codeTextNode.length)
      const endRect = endRange.getBoundingClientRect()
      const codeRects = Array.from(code.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
      const lastCodeRect = codeRects[codeRects.length - 1]
      const overlayRect = overlay.getBoundingClientRect()

      if (!lastCodeRect) {
        throw new Error("Wrapped inline code fragments missing")
      }

      return {
        insideEndLeft: endRect.left,
        lastCodeRight: lastCodeRect.right,
        overlayLeft: overlayRect.left,
      }
    })

    expect(Math.abs(metrics.overlayLeft - metrics.lastCodeRight)).toBeLessThan(1.25)
    expect(metrics.overlayLeft - metrics.insideEndLeft).toBeGreaterThan(1)
  })
})
