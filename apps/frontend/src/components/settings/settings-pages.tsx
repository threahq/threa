import type { ReactNode } from "react"
import type { SettingsTab } from "@threahq/types"
import { ProfileSettings } from "./profile-settings"
import { NotificationsSettings } from "./notifications-settings"
import { AppearanceSettings } from "./appearance-settings"
import { MessagesSettings } from "./messages-settings"
import { BoardSettings, InboxSettings, OpeningStreamsSettings } from "./inbox-settings"
import { KeyboardSettings } from "./keyboard-settings"
import { DateTimeSettings } from "./datetime-settings"
import { ScheduleSettings } from "./schedule-settings"
import { QuietHoursSetting } from "./quiet-hours-setting"
import { AISettings } from "./ai-settings"
import { DictationSettings } from "./dictation-settings"
import { CallSettings } from "./call-settings"
import { PrivacySettings } from "./privacy-settings"
import { DeveloperSettings } from "./developer-settings"
import { SettingRow, SettingsSection } from "./setting-primitives"
import { SpendLimitsSetting } from "./spend-limits-setting"
import { GeneralTab } from "@/components/workspace-settings/general-tab"
import { UsersTab } from "@/components/workspace-settings/users-tab"
import { ScheduleTab } from "@/components/workspace-settings/schedule-tab"
import { StatusesTab } from "@/components/workspace-settings/statuses-tab"
import { DictationTab } from "@/components/workspace-settings/dictation-tab"
import { PersonasTab } from "@/components/workspace-settings/personas-tab"
import { IntegrationsTab } from "@/components/workspace-settings/integrations-tab"
import { BotsTab } from "@/components/workspace-settings/bots-tab"
import { FeatureFlagsTab } from "@/components/workspace-settings/feature-flags-tab"

interface SettingsPageProps {
  tab: SettingsTab
  workspaceId: string
  onShortcutCaptureChange: (capturing: boolean) => void
}

/** The content of one settings page. */
export function SettingsPage({ tab, workspaceId, onShortcutCaptureChange }: SettingsPageProps): ReactNode {
  switch (tab) {
    case "profile":
      return <ProfileSettings />
    case "notifications":
      return (
        <div className="space-y-8">
          <NotificationsSettings />
          <SettingsSection section="notify-quiet">
            <QuietHoursSetting workspaceId={workspaceId} />
          </SettingsSection>
        </div>
      )
    case "appearance":
      return <AppearanceSettings />
    case "messages":
      return (
        <div className="space-y-8">
          <OpeningStreamsSettings />
          <MessagesSettings />
        </div>
      )
    case "inbox":
      return (
        <div className="space-y-8">
          <InboxSettings />
          <BoardSettings />
        </div>
      )
    case "keyboard":
      return <KeyboardSettings onCaptureStateChange={onShortcutCaptureChange} />
    case "datetime":
      return (
        <div className="space-y-8">
          <DateTimeSettings />
          <ScheduleSettings />
        </div>
      )
    case "ai":
      return <AISettings />
    case "voice":
      return (
        <div className="space-y-8">
          <DictationSettings />
          <CallSettings />
        </div>
      )
    case "privacy":
      return <PrivacySettings />
    case "developer":
      return <DeveloperSettings workspaceId={workspaceId} />
    case "early-access":
      return (
        <SettingsSection section="dev-flags">
          <SettingRow setting="feature-flags" labelFor={false} stacked>
            <FeatureFlagsTab workspaceId={workspaceId} />
          </SettingRow>
        </SettingsSection>
      )
    case "workspace":
      return <GeneralTab workspaceId={workspaceId} />
    case "members":
      return <UsersTab workspaceId={workspaceId} />
    case "workspace-defaults":
      return (
        <div className="space-y-8">
          <ScheduleTab workspaceId={workspaceId} />
          <StatusesTab workspaceId={workspaceId} />
          <DictationTab workspaceId={workspaceId} />
        </div>
      )
    case "workspace-ai":
      return (
        <div className="space-y-8">
          <PersonasTab workspaceId={workspaceId} />
          <SettingsSection section="ai-spend">
            <SpendLimitsSetting workspaceId={workspaceId} />
          </SettingsSection>
        </div>
      )
    case "integrations":
      return <IntegrationsTab workspaceId={workspaceId} />
    case "bots":
      return <BotsTab workspaceId={workspaceId} scope="shared" />
  }
}
