import * as React from "react"
import { useIsMobile } from "@/hooks/use-mobile"
import { ResponsiveModeProvider, useResponsiveMode } from "./responsive-mode"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "./drawer"
import { Button } from "./button"
import { cn } from "@/lib/utils"

// ── Root ────────────────────────────────────────────────────────────────

interface ResponsiveAlertDialogProps {
  children?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

function ResponsiveAlertDialog({ children, ...props }: ResponsiveAlertDialogProps) {
  const isMobile = useIsMobile()

  // Share the decision via context so the content and sub-parts can never
  // disagree with the root mid-resize (see responsive-mode.tsx).
  const root = isMobile ? <Drawer {...props}>{children}</Drawer> : <AlertDialog {...props}>{children}</AlertDialog>

  return <ResponsiveModeProvider isMobile={isMobile}>{root}</ResponsiveModeProvider>
}

// ── Content ─────────────────────────────────────────────────────────────

const ResponsiveAlertDialogContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogContent>
>(({ className, children, ...props }, ref) => {
  const isMobile = useResponsiveMode()

  if (isMobile) {
    // DrawerContent already renders its own Portal + Overlay internally
    return (
      <DrawerContent
        ref={ref}
        className={cn("max-h-[85dvh]", className)}
        {...(props as React.ComponentPropsWithoutRef<typeof DrawerContent>)}
      >
        {children}
      </DrawerContent>
    )
  }

  return (
    <AlertDialogContent ref={ref} className={className} {...props}>
      {children}
    </AlertDialogContent>
  )
})
ResponsiveAlertDialogContent.displayName = "ResponsiveAlertDialogContent"

// ── Header ──────────────────────────────────────────────────────────────

function ResponsiveAlertDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = useResponsiveMode()

  if (isMobile) {
    return <DrawerHeader className={cn("text-left", className)} {...props} />
  }

  return <AlertDialogHeader className={className} {...props} />
}
ResponsiveAlertDialogHeader.displayName = "ResponsiveAlertDialogHeader"

// ── Footer ──────────────────────────────────────────────────────────────

function ResponsiveAlertDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const isMobile = useResponsiveMode()

  if (isMobile) {
    return <DrawerFooter className={cn("pb-[max(16px,env(safe-area-inset-bottom))]", className)} {...props} />
  }

  return <AlertDialogFooter className={className} {...props} />
}
ResponsiveAlertDialogFooter.displayName = "ResponsiveAlertDialogFooter"

// ── Title ───────────────────────────────────────────────────────────────

const ResponsiveAlertDialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogTitle>
>(({ className, ...props }, ref) => {
  const isMobile = useResponsiveMode()

  if (isMobile) {
    return <DrawerTitle ref={ref} className={className} {...props} />
  }

  return <AlertDialogTitle ref={ref} className={className} {...props} />
})
ResponsiveAlertDialogTitle.displayName = "ResponsiveAlertDialogTitle"

// ── Description ─────────────────────────────────────────────────────────

const ResponsiveAlertDialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogDescription>
>(({ className, ...props }, ref) => {
  const isMobile = useResponsiveMode()

  if (isMobile) {
    return <DrawerDescription ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  }

  return <AlertDialogDescription ref={ref} className={className} {...props} />
})
ResponsiveAlertDialogDescription.displayName = "ResponsiveAlertDialogDescription"

// ── Action (confirm button) ─────────────────────────────────────────────

const ResponsiveAlertDialogAction = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogAction>
>(({ className, ...props }, ref) => {
  const isMobile = useResponsiveMode()

  if (isMobile) {
    return (
      <DrawerClose asChild>
        <Button
          ref={ref}
          className={cn("w-full", className)}
          {...props}
          onClick={(e) => {
            if (props.disabled) {
              e.preventDefault()
              return
            }
            props.onClick?.(e)
          }}
        />
      </DrawerClose>
    )
  }

  return <AlertDialogAction ref={ref} className={className} {...props} />
})
ResponsiveAlertDialogAction.displayName = "ResponsiveAlertDialogAction"

// ── Cancel (dismiss button) ─────────────────────────────────────────────

const ResponsiveAlertDialogCancel = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogCancel>
>(({ className, ...props }, ref) => {
  const isMobile = useResponsiveMode()

  if (isMobile) {
    return (
      <DrawerClose asChild>
        <Button ref={ref} variant="outline" className={cn("w-full", className)} {...props} />
      </DrawerClose>
    )
  }

  return <AlertDialogCancel ref={ref} className={className} {...props} />
})
ResponsiveAlertDialogCancel.displayName = "ResponsiveAlertDialogCancel"

// ── Exports ─────────────────────────────────────────────────────────────

export {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogTitle,
  ResponsiveAlertDialogDescription,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
}
