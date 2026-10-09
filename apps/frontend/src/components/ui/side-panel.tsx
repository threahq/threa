import * as React from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "./button"

const SidePanel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex h-full flex-col sm:border-l bg-background", className)} {...props} />
  )
)
SidePanel.displayName = "SidePanel"

const SidePanelTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => <h2 ref={ref} className={cn("font-semibold truncate", className)} {...props} />
)
SidePanelTitle.displayName = "SidePanelTitle"

interface SidePanelCloseProps extends React.ComponentPropsWithoutRef<typeof Button> {
  onClose: () => void
}

const SidePanelClose = React.forwardRef<HTMLButtonElement, SidePanelCloseProps>(
  ({ className, onClose, ...props }, ref) => (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8 shrink-0", className)}
      onClick={onClose}
      {...props}
    >
      <X className="h-4 w-4" />
      <span className="sr-only">Close</span>
    </Button>
  )
)
SidePanelClose.displayName = "SidePanelClose"

const SidePanelContent = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => <main ref={ref} className={cn("flex-1 overflow-hidden", className)} {...props} />
)
SidePanelContent.displayName = "SidePanelContent"

export { SidePanel, SidePanelTitle, SidePanelClose, SidePanelContent }
