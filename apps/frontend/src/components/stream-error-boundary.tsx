import type { ReactNode } from "react"
import { useStreamError } from "@/hooks/use-stream-error"
import { StreamErrorView } from "./stream-error-view"

interface StreamErrorBoundaryProps {
  streamId: string | undefined
  /** Additional error from a direct query (useStreamBootstrap, etc.) merged with coordinated loading errors. */
  queryError?: Error | null
  /** If provided, shows navigation buttons on the error page. */
  workspaceId?: string
  children: ReactNode
}

/**
 * Wraps stream-dependent content, showing an error view when either a
 * coordinated loading error or a direct query error is present.
 */
export function StreamErrorBoundary({ streamId, queryError, workspaceId, children }: StreamErrorBoundaryProps) {
  const error = useStreamError(streamId, queryError)

  if (error) {
    return <StreamErrorView type={error.type} workspaceId={workspaceId} />
  }

  return <>{children}</>
}
