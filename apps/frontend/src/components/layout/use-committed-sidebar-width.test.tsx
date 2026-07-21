import { render } from "@testing-library/react"
import { useRef } from "react"
import { describe, expect, it } from "vitest"
import { useCommittedSidebarWidth } from "./use-committed-sidebar-width"

function Harness({ width, state }: { width: number; state: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useCommittedSidebarWidth(ref, width, state)
  return <div ref={ref} data-testid="shell" />
}

describe("useCommittedSidebarWidth", () => {
  it("reclaims the live width when sidebar state changes without a persisted width change", () => {
    const view = render(<Harness width={260} state="pinned" />)
    const shell = view.getByTestId("shell")
    expect({
      content: shell.style.getPropertyValue("--nav-sidebar-width"),
      shell: shell.style.getPropertyValue("--nav-sidebar-shell-width"),
    }).toEqual({ content: "260px", shell: "260px" })

    shell.style.setProperty("--nav-sidebar-width", "200px")
    shell.style.setProperty("--nav-sidebar-shell-width", "6px")
    view.rerender(<Harness width={260} state="collapsed" />)

    expect({
      content: shell.style.getPropertyValue("--nav-sidebar-width"),
      shell: shell.style.getPropertyValue("--nav-sidebar-shell-width"),
    }).toEqual({ content: "260px", shell: "260px" })
  })
})
