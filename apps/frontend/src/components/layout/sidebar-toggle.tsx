import { PanelLeft, PanelLeftClose } from "lucide-react"
import { useSidebar } from "@/contexts"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface SidebarToggleProps {
  /**
   * Where this toggle is rendered:
   * - "sidebar": inside the sidebar header; always rendered — the sidebar's
   *   own container clips it (desktop) or slides it off-screen (mobile) when
   *   closed, so no discrete show/hide is needed here.
   * - "page": inside a page/stream header; slides left and fades as the
   *   sidebar pins open, reading as a "swap" with the sidebar copy which
   *   sits at the same viewport x.
   */
  location: "sidebar" | "page"
  className?: string
}

export function SidebarToggle({ location, className }: SidebarToggleProps) {
  const { state, isMobile, togglePinned } = useSidebar()
  const isPinned = state === "pinned"
  // Icon reflects what clicking will do.
  const willCollapse = isPinned || (isMobile && state === "preview")

  // Page toggle is only hidden when the sidebar is truly pinned open. In
  // `preview` (desktop hover) it stays visible so the user can still see the
  // affordance — clicking it locks the hover-preview into pinned.
  const hidden = location === "page" && isPinned

  // When hidden we also collapse the wrapper's flex footprint so following
  // header elements (back arrow, title) shift fully to the viewport edge — as
  // if the toggle were never rendered. `-mr-2` cancels the parent `gap-2`.
  return (
    <div
      className={cn(
        // shrink-0: overflow-hidden below means a squeezed wrapper slices the
        // button rather than fitting it. Crowded headers shrink the title.
        "flex shrink-0 items-center overflow-hidden transition-[width,margin,transform,opacity] duration-200 ease-out",
        hidden ? "pointer-events-none ml-0 -mr-2 w-0 -translate-x-2 opacity-0" : "w-8 opacity-100",
        className
      )}
      aria-hidden={hidden}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={togglePinned}
            tabIndex={hidden ? -1 : 0}
            aria-label={willCollapse ? "Collapse sidebar" : "Pin sidebar"}
          >
            {willCollapse ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{willCollapse ? "Collapse sidebar" : "Pin sidebar"}</TooltipContent>
      </Tooltip>
    </div>
  )
}
