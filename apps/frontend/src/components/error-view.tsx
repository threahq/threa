import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { AlertTriangle } from "lucide-react"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty"

interface ErrorViewProps {
  icon?: LucideIcon
  title?: string
  description?: string
  children?: ReactNode
  className?: string
}

/**
 * Generic error view for displaying errors anywhere in the app.
 * Use this for non-stream errors (events, messages, settings, etc.)
 *
 * For stream-specific errors (404/403), use StreamErrorView instead
 * which has branded messaging.
 */
export function ErrorView({
  icon: Icon = AlertTriangle,
  title = "Something Went Wrong",
  description = "We couldn't load this content. Please refresh the page or try again later.",
  children,
  className,
}: ErrorViewProps) {
  return (
    <Empty className={className}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  )
}
