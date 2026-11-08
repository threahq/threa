import { type ReactNode } from "react"
import { FloatingComposerShell } from "@/components/composer/floating-composer-shell"
import { Skeleton } from "@/components/ui/skeleton"
import { TimelineSkeleton } from "@/components/timeline/timeline-skeleton"

interface StreamContentShellProps {
  header: ReactNode
  content: ReactNode
  footer: ReactNode
}

/**
 * Stream content structural shell - defines layout without content.
 * Used by both real stream pages and skeleton to ensure identical structure.
 */
export function StreamContentShell({ header, content, footer }: StreamContentShellProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center justify-between border-b px-4">{header}</header>
      <main className="relative flex-1 overflow-hidden" data-editor-zone="main">
        {content}
        <FloatingComposerShell>{footer}</FloatingComposerShell>
      </main>
    </div>
  )
}

function HeaderSkeleton() {
  return (
    <>
      <Skeleton className="h-6 w-40" />
      <div className="flex items-center gap-1">
        <Skeleton className="h-8 w-8 rounded-md" />
        <Skeleton className="h-8 w-8 rounded-md" />
      </div>
    </>
  )
}

function FooterSkeleton() {
  return <Skeleton className="h-[46px] sm:h-24 w-full rounded-[16px] sm:rounded-md" />
}

/** Guaranteed to have identical structure to real stream content. */
export function StreamContentSkeleton() {
  return <StreamContentShell header={<HeaderSkeleton />} content={<TimelineSkeleton />} footer={<FooterSkeleton />} />
}
