import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { ResponsiveSettingsNav, SETTINGS_DIALOG_LAYOUT_CLASSNAMES } from "@/components/ui/responsive-settings-nav"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import {
  WORKSPACE_SETTINGS_TABS,
  WORKSPACE_SETTINGS_TAB_CONFIG,
  WS_SETTINGS_PARAM,
  type WorkspaceSettingsTab,
} from "./tab-config"
import { GeneralTab } from "./general-tab"
import { UsersTab } from "./users-tab"
import { ApiKeysTab } from "./api-keys-tab"
import { BotsTab } from "./bots-tab"
import { IntegrationsTab } from "./integrations-tab"
import { ScheduleTab } from "./schedule-tab"
import { StatusesTab } from "./statuses-tab"

interface WorkspaceSettingsDialogProps {
  workspaceId: string
}

export function WorkspaceSettingsDialog({ workspaceId }: WorkspaceSettingsDialogProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [mounted, setMounted] = useState(false)

  const settingsParam = searchParams.get(WS_SETTINGS_PARAM)
  const normalizedSettingsParam = settingsParam === "members" ? "users" : settingsParam
  const isOpen = settingsParam !== null
  const activeTab: WorkspaceSettingsTab =
    normalizedSettingsParam && WORKSPACE_SETTINGS_TABS.includes(normalizedSettingsParam as WorkspaceSettingsTab)
      ? (normalizedSettingsParam as WorkspaceSettingsTab)
      : "general"

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null

  const close = () => {
    const newParams = new URLSearchParams(searchParams)
    newParams.delete(WS_SETTINGS_PARAM)
    setSearchParams(newParams, { replace: true })
  }

  const setTab = (tab: string) => {
    const newParams = new URLSearchParams(searchParams)
    newParams.set(WS_SETTINGS_PARAM, tab)
    setSearchParams(newParams, { replace: true })
  }

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <ResponsiveDialogContent
        desktopClassName="w-[min(96vw,980px)] max-w-none h-[min(720px,calc(100vh-2rem))] sm:flex flex-col overflow-hidden p-0 gap-0"
        drawerClassName="flex flex-col gap-0"
        hideCloseButton
      >
        <ResponsiveDialogHeader className="border-b px-4 py-4 sm:px-6 sm:py-5">
          <ResponsiveDialogTitle>Workspace Settings</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Manage workspace details, members, bots, and API keys.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <Tabs
          data-slot="settings-tabs"
          value={activeTab}
          onValueChange={setTab}
          className={SETTINGS_DIALOG_LAYOUT_CLASSNAMES.tabs}
        >
          <div data-slot="settings-panels" className={SETTINGS_DIALOG_LAYOUT_CLASSNAMES.panels}>
            <ResponsiveSettingsNav
              tabs={WORKSPACE_SETTINGS_TABS}
              items={WORKSPACE_SETTINGS_TAB_CONFIG}
              value={activeTab}
              onValueChange={setTab}
            />

            <div data-slot="settings-content" className={SETTINGS_DIALOG_LAYOUT_CLASSNAMES.content}>
              <TabsContent value="general" className="mt-0">
                <GeneralTab workspaceId={workspaceId} />
              </TabsContent>
              <TabsContent value="schedule" className="mt-0">
                <ScheduleTab workspaceId={workspaceId} />
              </TabsContent>
              <TabsContent value="statuses" className="mt-0">
                <StatusesTab workspaceId={workspaceId} />
              </TabsContent>
              <TabsContent value="users" className="mt-0">
                <UsersTab workspaceId={workspaceId} />
              </TabsContent>
              <TabsContent value="integrations" className="mt-0">
                <IntegrationsTab workspaceId={workspaceId} />
              </TabsContent>
              <TabsContent value="bots" className="mt-0">
                <BotsTab workspaceId={workspaceId} />
              </TabsContent>
              <TabsContent value="api-keys" className="mt-0">
                <ApiKeysTab workspaceId={workspaceId} />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
