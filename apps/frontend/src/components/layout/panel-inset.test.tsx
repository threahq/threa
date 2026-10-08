import { describe, it, expect, beforeEach } from "vitest"
import { render } from "@/test"
import { usePanelInset } from "./panel-inset"

function Inset({ right, animates }: { right: number; animates: boolean }) {
  usePanelInset(right, animates)
  return null
}

function inset() {
  const style = document.documentElement.style
  return {
    right: style.getPropertyValue("--panel-inset-right"),
    duration: style.getPropertyValue("--panel-inset-duration"),
  }
}

describe("usePanelInset", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style")
  })

  it("publishes the open panel's width with no duration while it isn't animating", () => {
    render(<Inset right={420} animates={false} />)
    expect(inset()).toEqual({ right: "420px", duration: "0ms" })
  })

  it("publishes 0px for a closed panel", () => {
    render(<Inset right={0} animates={false} />)
    expect(inset()).toEqual({ right: "0px", duration: "0ms" })
  })

  it("publishes the open/close animation duration while the panel animates", () => {
    const { rerender } = render(<Inset right={420} animates />)
    expect(inset()).toEqual({ right: "420px", duration: "200ms" })

    rerender(<Inset right={500} animates={false} />)
    expect(inset()).toEqual({ right: "500px", duration: "0ms" })
  })

  it("resets the inset when its owner unmounts", () => {
    const { unmount } = render(<Inset right={420} animates />)
    unmount()
    expect(inset()).toEqual({ right: "0px", duration: "0ms" })
  })

  it("keeps the incoming owner's inset when one instance swaps for another in a commit", () => {
    // The consumer (the fullscreen call overlay) outlives the route, so a teardown
    // landing after the new mount would leave it reading 0px over an open panel.
    const { rerender } = render(<Inset key="from" right={420} animates={false} />)
    expect(inset()).toEqual({ right: "420px", duration: "0ms" })

    rerender(<Inset key="to" right={360} animates={false} />)
    expect(inset()).toEqual({ right: "360px", duration: "0ms" })
  })
})
