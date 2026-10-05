import { describe, expect, it } from "vitest"
import type { SidebarSection } from "./sidebar-config"
import { shareSections } from "./stable-rows"

const row = (id: string, preview: string) => ({ id, lastMessagePreview: { content: preview } })

describe("shareSections", () => {
  const section = { id: "sec_1" } as SidebarSection
  const other = { id: "sec_2" } as SidebarSection

  it("returns the previous sections when a rebuild changed nothing", () => {
    const prev = [{ section, items: [row("a", "one")] as never[] }]
    expect(shareSections(prev, [{ section, items: [row("a", "one")] as never[] }])).toBe(prev)
  })

  it("keeps the untouched section entry when a sibling changed", () => {
    const prev = [
      { section, items: [row("a", "one")] as never[] },
      { section: other, items: [row("b", "two")] as never[] },
    ]
    const shared = shareSections(prev, [
      { section, items: [row("a", "one")] as never[] },
      { section: other, items: [row("b", "three")] as never[] },
    ])
    expect(shared[0]).toBe(prev[0])
    expect(shared[1]).not.toBe(prev[1])
  })
})
