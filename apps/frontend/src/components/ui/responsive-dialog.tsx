import * as React from "react"
import { useIsMobile } from "@/hooks/use-mobile"
import { ResponsiveModeProvider, useResponsiveMode } from "./responsive-mode"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer"
import { cn } from "@/lib/utils"

// ── Constants ───────────────────────────────────────────────────────────

/** Default snap points: 80% of screen, expandable to full screen */
const DEFAULT_SNAP_POINTS = [0.8, 1] as const
const DEFAULT_ACTIVE_SNAP = 0.8

// Shares the `disableSnapPoints` flag with `ResponsiveDialogContent` so the
// content can drop the vaul `h-[100dvh]` requirement when there are no
// snap points to anchor to.
const DisableSnapPointsContext = React.createContext(false)

// ── Root ────────────────────────────────────────────────────────────────

interface ResponsiveDialogProps {
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Override snap points for mobile drawer. Set to `undefined` to use defaults. */
  snapPoints?: (number | string)[]
  /**
   * Skip vaul snap points entirely on mobile and render a content-driven
   * drawer (matches `MessageEditForm`'s pattern). Use this when the dialog
   * is designed to take the whole viewport on mobile and the partial-snap
   * UX would obscure the action bar / trailing buttons.
   */
  disableSnapPoints?: boolean
}

function ResponsiveDialog({ children, snapPoints, disableSnapPoints, ...props }: ResponsiveDialogProps) {
  const isMobile = useIsMobile()
  const resolvedSnaps = React.useMemo(() => snapPoints ?? [...DEFAULT_SNAP_POINTS], [snapPoints])
  const [activeSnap, setActiveSnap] = React.useState<number | string | null>(DEFAULT_ACTIVE_SNAP)

  // Reset snap point when drawer opens
  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (open) setActiveSnap(resolvedSnaps[0])
      props.onOpenChange?.(open)
    },
    [props.onOpenChange, resolvedSnaps]
  )

  // Resolve the root once and share the decision via context so the content and
  // sub-parts can never disagree with the root mid-resize (see responsive-mode.tsx).
  let root: React.ReactNode
  if (isMobile && disableSnapPoints) {
    root = (
      <DisableSnapPointsContext.Provider value={true}>
        <Drawer open={props.open} onOpenChange={props.onOpenChange}>
          {children}
        </Drawer>
      </DisableSnapPointsContext.Provider>
    )
  } else if (isMobile) {
    root = (
      <Drawer
        open={props.open}
        onOpenChange={handleOpenChange}
        snapPoints={resolvedSnaps}
        activeSnapPoint={activeSnap}
        setActiveSnapPoint={setActiveSnap}
        fadeFromIndex={resolvedSnaps.length - 1}
      >
        {children}
      </Drawer>
    )
  } else {
    root = <Dialog {...props}>{children}</Dialog>
  }

  return <ResponsiveModeProvider isMobile={isMobile}>{root}</ResponsiveModeProvider>
}

// ── Trigger ─────────────────────────────────────────────────────────────

const ResponsiveDialogTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof DialogTrigger>
>(({ className, ...props }, ref) => {
  const isMobile = useResponsiveMode()
  const Comp = isMobile ? DrawerTrigger : DialogTrigger
  return <Comp ref={ref} className={className} {...props} />
})
ResponsiveDialogTrigger.displayName = "ResponsiveDialogTrigger"

// ── Close ───────────────────────────────────────────────────────────────

const ResponsiveDialogClose = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof DialogClose>>(
  ({ className, ...props }, ref) => {
    const isMobile = useResponsiveMode()
    const Comp = isMobile ? DrawerClose : DialogClose
    return <Comp ref={ref} className={className} {...props} />
  }
)
ResponsiveDialogClose.displayName = "ResponsiveDialogClose"

// ── Content ─────────────────────────────────────────────────────────────

interface ResponsiveDialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogContent> {
  /** Class applied only on desktop Dialog */
  desktopClassName?: string
  /** Class applied only on mobile Drawer */
  drawerClassName?: string
}

const ResponsiveDialogContent = React.forwardRef<HTMLDivElement, ResponsiveDialogContentProps>(
  ({ className, desktopClassName, drawerClassName, children, hideCloseButton, ...props }, ref) => {
    const isMobile = useResponsiveMode()
    const noSnapPoints = React.useContext(DisableSnapPointsContext)

    if (isMobile) {
      // With snap points: vaul's transform-based positioning needs the drawer
      // to be full viewport height so `translate3d(0, offset, 0)` controls the
      // visible portion (e.g. 80% at 0.8 snap). Without snap points: content-
      // driven height is what callers want (matches `MessageEditForm` shape),
      // so we skip the h-[100dvh] override and let `drawerClassName` decide.
      return (
        <DrawerContent
          ref={ref}
          className={cn(noSnapPoints ? null : "h-[100dvh]", drawerClassName, className)}
          {...props}
        >
          {children}
        </DrawerContent>
      )
    }

    // DialogContent already renders its own Portal + Overlay internally
    return (
      <DialogContent ref={ref} className={cn(desktopClassName, className)} hideCloseButton={hideCloseButton} {...props}>
        {children}
      </DialogContent>
    )
  }
)
ResponsiveDialogContent.displayName = "ResponsiveDialogContent"

// ── Header ──────────────────────────────────────────────────────────────

function ResponsiveDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = useResponsiveMode()

  if (isMobile) {
    // Override DrawerHeader's default p-4 to avoid double padding — callers set their own px/pt
    return <DrawerHeader className={cn("text-left p-0 px-4 pb-2", className)} {...props} />
  }

  return <DialogHeader className={className} {...props} />
}
ResponsiveDialogHeader.displayName = "ResponsiveDialogHeader"

// ── Footer ──────────────────────────────────────────────────────────────

function ResponsiveDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = useResponsiveMode()

  if (isMobile) {
    return <DrawerFooter className={cn("pb-[max(16px,env(safe-area-inset-bottom))]", className)} {...props} />
  }

  return <DialogFooter className={className} {...props} />
}
ResponsiveDialogFooter.displayName = "ResponsiveDialogFooter"

// ── Title ───────────────────────────────────────────────────────────────

const ResponsiveDialogTitle = React.forwardRef<HTMLHeadingElement, React.ComponentPropsWithoutRef<typeof DialogTitle>>(
  ({ className, ...props }, ref) => {
    const isMobile = useResponsiveMode()

    if (isMobile) {
      return <DrawerTitle ref={ref} className={className} {...props} />
    }

    return <DialogTitle ref={ref} className={className} {...props} />
  }
)
ResponsiveDialogTitle.displayName = "ResponsiveDialogTitle"

// ── Description ─────────────────────────────────────────────────────────

const ResponsiveDialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof DialogDescription>
>(({ className, ...props }, ref) => {
  const isMobile = useResponsiveMode()

  if (isMobile) {
    return <DrawerDescription ref={ref} className={className} {...props} />
  }

  return <DialogDescription ref={ref} className={className} {...props} />
})
ResponsiveDialogDescription.displayName = "ResponsiveDialogDescription"

// ── Body (scrollable content area) ──────────────────────────────────────

function ResponsiveDialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex-1 overflow-y-auto px-4 sm:px-6", className)} {...props} />
}
ResponsiveDialogBody.displayName = "ResponsiveDialogBody"

// ── Exports ─────────────────────────────────────────────────────────────

export {
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogFooter,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogBody,
}
