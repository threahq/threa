import { useEffect, useState } from "react"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { ResponsiveSettingsNav, SETTINGS_DIALOG_LAYOUT_CLASSNAMES } from "@/components/ui/responsive-settings-nav"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { useSettings } from "@/contexts"
import { SETTINGS_TABS, type SettingsTab } from "@threa/types"
import { AISettings } from "./ai-settings"
import { ProfileSettings } from "./profile-settings"
import { AppearanceSettings } from "./appearance-settings"
import { DateTimeSettings } from "./datetime-settings"
import { NotificationsSettings } from "./notifications-settings"
import { KeyboardSettings } from "./keyboard-settings"
import { AccessibilitySettings } from "./accessibility-settings"

const TAB_CONFIG: Record<SettingsTab, { label: string; description: string }> = {
  profile: { label: "Profile", description: "Identity and account details" },
  ai: { label: "AI", description: "Scratchpad behavior, guidance, and voice dictation" },
  appearance: { label: "Appearance", description: "Theme and message density" },
  datetime: { label: "Date & Time", description: "Timezone and formatting" },
  notifications: { label: "Notifications", description: "Alerts and push behavior" },
  keyboard: { label: "Keyboard", description: "Shortcuts and send behavior" },
  accessibility: { label: "Accessibility", description: "Motion, contrast, and fonts" },
}

export function SettingsDialog() {
  const { isOpen, activeTab, closeSettings, setActiveTab } = useSettings()
  const [mounted, setMounted] = useState(false)
  const [isShortcutCaptureActive, setIsShortcutCaptureActive] = useState(false)

  // Delay dialog render until after hydration to avoid scroll lock measurement issues
  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={(open) => !open && closeSettings()}>
      <ResponsiveDialogContent
        desktopClassName="w-[min(96vw,980px)] max-w-none h-[min(720px,calc(100vh-2rem))] sm:flex flex-col overflow-hidden p-0 gap-0"
        drawerClassName="flex flex-col gap-0"
        hideCloseButton
        onEscapeKeyDown={(event) => {
          if (isShortcutCaptureActive) {
            event.preventDefault()
          }
        }}
      >
        <ResponsiveDialogHeader className="border-b px-4 py-4 sm:px-6 sm:py-5">
          <ResponsiveDialogTitle>Settings</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Manage your profile, AI preferences, notifications, and accessibility settings.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <Tabs
          data-slot="settings-tabs"
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as SettingsTab)}
          className={SETTINGS_DIALOG_LAYOUT_CLASSNAMES.tabs}
        >
          <div data-slot="settings-panels" className={SETTINGS_DIALOG_LAYOUT_CLASSNAMES.panels}>
            <ResponsiveSettingsNav
              tabs={SETTINGS_TABS}
              items={TAB_CONFIG}
              value={activeTab}
              onValueChange={(value) => setActiveTab(value as SettingsTab)}
            />

            <div data-slot="settings-content" className={SETTINGS_DIALOG_LAYOUT_CLASSNAMES.content}>
              <TabsContent value="profile" className="mt-0">
                <ProfileSettings />
              </TabsContent>
              <TabsContent value="ai" className="mt-0">
                <AISettings />
              </TabsContent>
              <TabsContent value="appearance" className="mt-0">
                <AppearanceSettings />
              </TabsContent>
              <TabsContent value="datetime" className="mt-0">
                <DateTimeSettings />
              </TabsContent>
              <TabsContent value="notifications" className="mt-0">
                <NotificationsSettings />
              </TabsContent>
              <TabsContent value="keyboard" className="mt-0">
                <KeyboardSettings onCaptureStateChange={setIsShortcutCaptureActive} />
              </TabsContent>
              <TabsContent value="accessibility" className="mt-0">
                <AccessibilitySettings />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
