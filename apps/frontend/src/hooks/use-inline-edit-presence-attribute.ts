import { useEffect } from "react"

const INLINE_EDIT_ATTR = "data-inline-edit"
const INLINE_EDIT_SELECTOR = `[${INLINE_EDIT_ATTR}]`
const BODY_ACTIVE_ATTR = "data-inline-edit-active"

function countInlineEditElements(node: Node): number {
  if (!(node instanceof Element)) return 0
  return (node.hasAttribute(INLINE_EDIT_ATTR) ? 1 : 0) + node.querySelectorAll(INLINE_EDIT_SELECTOR).length
}

function setBodyActive(active: boolean): void {
  document.body.toggleAttribute(BODY_ACTIVE_ATTR, active)
}

export function useInlineEditPresenceAttribute(): void {
  useEffect(() => {
    let inlineEditCount = document.body.querySelectorAll(INLINE_EDIT_SELECTOR).length
    setBodyActive(inlineEditCount > 0)

    const observer = new MutationObserver((mutations) => {
      let nextCount = inlineEditCount

      if (mutations.some((mutation) => mutation.type === "attributes")) {
        nextCount = document.body.querySelectorAll(INLINE_EDIT_SELECTOR).length
      } else {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) nextCount += countInlineEditElements(node)
          for (const node of mutation.removedNodes) nextCount -= countInlineEditElements(node)
        }

        if (nextCount < 0) {
          nextCount = document.body.querySelectorAll(INLINE_EDIT_SELECTOR).length
        }
      }

      if (nextCount === inlineEditCount) return
      inlineEditCount = nextCount
      setBodyActive(inlineEditCount > 0)
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [INLINE_EDIT_ATTR],
    })

    return () => {
      observer.disconnect()
      document.body.removeAttribute(BODY_ACTIVE_ATTR)
    }
  }, [])
}
