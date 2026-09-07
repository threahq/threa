import { useEffect, useLayoutEffect, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { QueryClientProvider } from "@tanstack/react-query"
import { makeQueryClient } from "@/contexts/query-client"
import { PreferencesProvider } from "@/contexts/preferences-context"
import { SidebarProvider } from "@/contexts/sidebar-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppStatusPage } from "@/pages/app-status"
import { AppUpdateProvider, useAppUpdate } from "@/hooks/use-app-update"
import { AppToastHost } from "@/components/app-update-toast"
import "@/index.css"

declare const __APP_VERSION__: string
declare const __APP_BUILD_ID__: string

const queryClient = makeQueryClient()
const WORKSPACE_ID = "workspace_test"

const w = typeof window !== "undefined" ? window : undefined

function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((err) => console.error("[fixture] SW registration failed", err))
  }, [])
  return null
}

function UpdateStateExporter() {
  const update = useAppUpdate()
  useLayoutEffect(() => {
    if (!w) return
    w.__appUpdateState = {
      phase: update.phase,
      readyBuildId: update.readyBuildId,
      failure: update.failure,
      lastCheckedAt: update.lastCheckedAt,
    }
  }, [update.phase, update.readyBuildId, update.failure, update.lastCheckedAt])
  return null
}

export function Fixture(): ReactNode {
  useEffect(() => {
    if (!w) return
    w.__fixtureVersion = __APP_VERSION__
    w.__fixtureBuildId = __APP_BUILD_ID__
    w.__importLazyFixture = async () => {
      const mod = await import("./lazy-chunk")
      w.__fixtureLazyUrl = new URL(mod.url).pathname
      return mod.default
    }
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <AppUpdateProvider>
        <BrowserRouter>
          <TooltipProvider delayDuration={0}>
            <SidebarProvider>
              <PreferencesProvider workspaceId={WORKSPACE_ID}>
                <ServiceWorkerRegistration />
                <UpdateStateExporter />
                <Routes>
                  <Route path="/w/:workspaceId/app-status" element={<AppStatusPage />} />
                  <Route path="*" element={<Navigate to={`/w/${WORKSPACE_ID}/app-status`} replace />} />
                </Routes>
                <AppToastHost />
              </PreferencesProvider>
            </SidebarProvider>
          </TooltipProvider>
        </BrowserRouter>
      </AppUpdateProvider>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
