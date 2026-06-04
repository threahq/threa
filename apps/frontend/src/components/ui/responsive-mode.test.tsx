import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import * as mobileModule from "@/hooks/use-mobile"
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogTitle,
} from "./responsive-alert-dialog"
import { ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogTitle } from "./responsive-dialog"

afterEach(() => vi.restoreAllMocks())

/**
 * Make `useIsMobile` report mobile to the first caller (the responsive root) and
 * desktop to everyone after it. That is exactly the inconsistency a viewport
 * resize crossing the breakpoint can produce for one commit: the root has
 * already swapped to a <Drawer> while the content still thinks it's desktop.
 *
 * Before the context fix, the content rendered an AlertDialogContent /
 * DialogContent (a scoped radix DialogPortal) under a vaul <Drawer>, throwing
 * "`DialogPortal` must be used within `Dialog`" during React's concurrent
 * render (it surfaces as a recovered concurrent-render error that fails the
 * suite). After the fix, the content follows the root's committed mode and
 * renders the drawer variant instead.
 */
function mockTornResize() {
  let call = 0
  vi.spyOn(mobileModule, "useIsMobile").mockImplementation(() => call++ === 0)
}

describe("ResponsiveAlertDialog mode coupling", () => {
  beforeEach(mockTornResize)

  it("does not orphan a scoped DialogPortal when root and content disagree", () => {
    expect(() =>
      render(
        <ResponsiveAlertDialog open onOpenChange={() => {}}>
          <ResponsiveAlertDialogContent>
            <ResponsiveAlertDialogTitle>Delete?</ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogContent>
        </ResponsiveAlertDialog>
      )
    ).not.toThrow()

    expect(screen.getByText("Delete?")).toBeInTheDocument()
    // Content followed the root's mobile decision: the drawer (role "dialog")
    // rendered, not the desktop AlertDialog (role "alertdialog").
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })
})

describe("ResponsiveDialog mode coupling", () => {
  beforeEach(mockTornResize)

  it("does not crash when root and content disagree", () => {
    expect(() =>
      render(
        <ResponsiveDialog open onOpenChange={() => {}}>
          <ResponsiveDialogContent>
            <ResponsiveDialogTitle>Settings</ResponsiveDialogTitle>
          </ResponsiveDialogContent>
        </ResponsiveDialog>
      )
    ).not.toThrow()

    expect(screen.getByText("Settings")).toBeInTheDocument()
  })
})
