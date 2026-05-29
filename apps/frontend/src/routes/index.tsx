import { useEffect, useRef } from "react"
import { createBrowserRouter, Navigate, useLocation, useParams } from "react-router-dom"
import { ErrorBoundary } from "@/components/error-boundary"
import { FallbackLoader } from "@/components/fallback-loader"
import { useSidebar } from "@/contexts"
import { useLastStream } from "@/hooks"
import { getLastWorkspaceId } from "@/lib/last-workspace"

// Route-level code splitting: each page lazy-loads its own chunk so heavy
// dependencies (tiptap/prosemirror, recharts, limax/pinyin-pro, etc.) ride
// with the pages that actually use them instead of bloating the main bundle.
export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootRedirect />,
    errorElement: <ErrorBoundary />,
  },
  {
    path: "/login",
    HydrateFallback: FallbackLoader,
    lazy: async () => ({ Component: (await import("@/pages/login")).LoginPage }),
    errorElement: <ErrorBoundary />,
  },
  {
    path: "/workspaces",
    HydrateFallback: FallbackLoader,
    lazy: async () => ({ Component: (await import("@/pages/workspace-select")).WorkspaceSelectPage }),
    errorElement: <ErrorBoundary />,
  },
  {
    // Custom add-account picker. Sits in front of `/api/auth/login?intent=add`
    // because AuthKit's hosted UI silent-refreshes and can't reliably show an
    // account picker. Buttons hit provider-direct social URLs or the magic
    // auth endpoints — see apps/control-plane/src/features/auth/handlers.ts.
    path: "/add-account",
    HydrateFallback: FallbackLoader,
    lazy: async () => ({ Component: (await import("@/pages/add-account")).AddAccountPage }),
    errorElement: <ErrorBoundary />,
  },
  {
    path: "/share",
    HydrateFallback: FallbackLoader,
    lazy: async () => ({ Component: (await import("@/pages/share-target")).ShareTargetPage }),
    errorElement: <ErrorBoundary />,
  },
  {
    // Public, unauthenticated. The recipient enters their email to claim the
    // invitation — no workspace bootstrap needed, lives outside WorkspaceLayout.
    path: "/join/:token",
    HydrateFallback: FallbackLoader,
    lazy: async () => ({ Component: (await import("@/pages/join")).JoinPage }),
    errorElement: <ErrorBoundary />,
  },
  {
    // Setup page lives outside WorkspaceLayout — it's a lightweight form that
    // doesn't need the full workspace bootstrap (socket, sidebar, etc.)
    path: "/w/:workspaceId/setup",
    HydrateFallback: FallbackLoader,
    lazy: async () => ({ Component: (await import("@/pages/user-setup")).UserSetupPage }),
    errorElement: <ErrorBoundary />,
  },
  {
    path: "/w/:workspaceId",
    HydrateFallback: FallbackLoader,
    lazy: async () => ({ Component: (await import("@/pages/workspace-layout")).WorkspaceLayout }),
    errorElement: <ErrorBoundary />,
    children: [
      {
        index: true,
        element: <WorkspaceHome />,
      },
      {
        path: "drafts",
        HydrateFallback: FallbackLoader,
        lazy: async () => ({ Component: (await import("@/pages/drafts")).DraftsPage }),
      },
      {
        path: "saved/:tab?",
        HydrateFallback: FallbackLoader,
        lazy: async () => ({ Component: (await import("@/pages/saved")).SavedPage }),
      },
      {
        path: "scheduled/:tab?",
        HydrateFallback: FallbackLoader,
        lazy: async () => ({ Component: (await import("@/pages/scheduled")).ScheduledPage }),
      },
      {
        path: "activity/:filter?",
        HydrateFallback: FallbackLoader,
        lazy: async () => ({ Component: (await import("@/pages/activity")).ActivityPage }),
      },
      {
        path: "memory",
        HydrateFallback: FallbackLoader,
        lazy: async () => ({ Component: (await import("@/pages/memory")).MemoryPage }),
      },
      {
        path: "labels",
        HydrateFallback: FallbackLoader,
        lazy: async () => ({ Component: (await import("@/pages/labels")).LabelsPage }),
      },
      {
        path: "files",
        HydrateFallback: FallbackLoader,
        lazy: async () => ({ Component: (await import("@/pages/files")).FilesPage }),
      },
      {
        path: "memos/:memoId",
        element: <LegacyMemoRedirect />,
      },
      {
        path: "s/:streamId",
        HydrateFallback: FallbackLoader,
        lazy: async () => ({ Component: (await import("@/pages/stream")).StreamPage }),
      },
      {
        path: "share",
        HydrateFallback: FallbackLoader,
        lazy: async () => ({ Component: (await import("@/pages/share-picker")).SharePickerPage }),
      },
      {
        path: "admin/ai-usage",
        HydrateFallback: FallbackLoader,
        lazy: async () => ({ Component: (await import("@/pages/ai-usage-admin")).AIUsageAdminPage }),
      },
    ],
  },
])

// PWA `start_url` is `/`. A returning user almost always wants the workspace
// they last had open, which renders instantly from IndexedDB — so jump
// straight there instead of routing through `/workspaces` and blocking on the
// control-plane list round trip just to rediscover it. Purely a navigation
// hint: WorkspaceLayout still enforces auth/membership and a stale/unknown id
// falls back to the normal bootstrap path. No cached id ⇒ unchanged behavior.
export function RootRedirect() {
  const lastWorkspaceId = getLastWorkspaceId()
  if (lastWorkspaceId) {
    return <Navigate to={`/w/${lastWorkspaceId}`} replace />
  }
  return <Navigate to="/workspaces" replace />
}

/** Workspace index route — redirects to a stream or opens the sidebar. */
export function WorkspaceHome() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const location = useLocation()
  const { state, togglePinned } = useSidebar()
  const { redirectStreamId, shouldOpenSidebar } = useLastStream(workspaceId ?? "")
  const sidebarOpenedRef = useRef(false)

  useEffect(() => {
    if (shouldOpenSidebar && state === "collapsed" && !sidebarOpenedRef.current) {
      sidebarOpenedRef.current = true
      togglePinned()
    }
  }, [shouldOpenSidebar, state, togglePinned])

  if (redirectStreamId && workspaceId) {
    return (
      <Navigate
        to={{
          pathname: `/w/${workspaceId}/s/${redirectStreamId}`,
          search: location.search,
        }}
        replace
      />
    )
  }

  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <p>Select a stream from the sidebar</p>
    </div>
  )
}

export function LegacyMemoRedirect() {
  const { workspaceId, memoId } = useParams<{ workspaceId: string; memoId: string }>()
  const location = useLocation()

  if (!workspaceId || !memoId) {
    return <Navigate to="/workspaces" replace />
  }

  const params = new URLSearchParams(location.search)
  params.set("memo", memoId)

  return (
    <Navigate
      to={{
        pathname: `/w/${workspaceId}/memory`,
        search: `?${params.toString()}`,
      }}
      replace
    />
  )
}
