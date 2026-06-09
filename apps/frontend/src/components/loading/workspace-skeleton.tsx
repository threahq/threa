import { type ReactNode } from "react"
import { FloatingComposerShell } from "@/components/composer/floating-composer-shell"
import { Skeleton } from "@/components/ui/skeleton"

// ============================================================================
// Stream Content Shell - defines structural layout for main content area
// ============================================================================

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

// ============================================================================
// Skeleton content for each slot
// ============================================================================

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

function ContentSkeleton() {
  return (
    <div className="px-4 pb-4">
      <div className="h-3 sm:h-6" />
      <div className="space-y-4">
        <MessageSkeleton />
        <MessageSkeleton />
        <MessageSkeleton />
        <MessageSkeleton />
      </div>
    </div>
  )
}

function MessageSkeleton() {
  return (
    <div className="flex gap-3">
      {/* Avatar */}
      <Skeleton className="h-9 w-9 flex-shrink-0 rounded-full" />

      {/* Content */}
      <div className="flex-1 space-y-2">
        {/* Header row */}
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-12" />
        </div>

        {/* Message content */}
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  )
}

function FooterSkeleton() {
  return <Skeleton className="h-[46px] sm:h-24 w-full rounded-[16px] sm:rounded-md" />
}

// ============================================================================
// Composed skeleton using the shell
// ============================================================================

/**
 * Stream content skeleton using the shell pattern.
 * Guaranteed to have identical structure to real stream content.
 */
export function StreamContentSkeleton() {
  return <StreamContentShell header={<HeaderSkeleton />} content={<ContentSkeleton />} footer={<FooterSkeleton />} />
}

// ============================================================================
// Legacy export for SidebarSkeleton (now defined in sidebar.tsx)
// Re-export for backwards compatibility during transition
// ============================================================================

// Note: SidebarSkeleton is now co-located with Sidebar in sidebar.tsx
// This file only exports StreamContentShell and StreamContentSkeleton
