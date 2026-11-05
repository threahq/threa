import { useState } from "react"
import { useParams } from "react-router-dom"
import { usePreferences } from "@/contexts"
import { useFeatureFlag } from "@/hooks"
import { useWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { ApiError } from "@/api/client"
import { EncryptionKeysSetting } from "@/components/encryption"
import type { UpdateUserPreferencesInput, UserPreferences } from "@threahq/types"
import { INSTALLATION_OFF, SettingsSection, SwitchSetting, type SettingUnavailable } from "./setting-primitives"
import { DiagnosticsSettings } from "./diagnostics-settings"

const NEEDS_CRASH_REPORTS: SettingUnavailable = {
  reason: "Turn on crash reports and usage data first.",
  value: "Off until crash reports are on",
}

/**
 * Crash reports and session recording as they actually stand: only on where
 * this installation collects analytics at all, whatever was stored before.
 */
export function effectiveDataSharing(
  analyticsConfigured: boolean,
  preferences: Pick<UserPreferences, "analyticsConsent" | "sessionReplayOptIn"> | null | undefined
) {
  const granted = analyticsConfigured && preferences?.analyticsConsent === "granted"
  return { granted, replayOptIn: granted && preferences?.sessionReplayOptIn === true }
}

/** Why each data-sharing switch can't be changed, if it can't. */
export function dataSharingUnavailable(
  analyticsConfigured: boolean,
  granted: boolean
): Record<"crashReports" | "sessionRecording", SettingUnavailable | null> {
  if (!analyticsConfigured) return { crashReports: INSTALLATION_OFF, sessionRecording: INSTALLATION_OFF }
  return { crashReports: null, sessionRecording: granted ? null : NEEDS_CRASH_REPORTS }
}

type PrivacyPreference = "analyticsConsent" | "sessionReplayOptIn" | "shareDeviceWithAgents"

export function PrivacySettings() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>()
  const { preferences, updatePreference } = usePreferences()
  const { data: bootstrap } = useWorkspaceBootstrap(workspaceId)
  const diagnosticsOffered = useFeatureFlag(workspaceId, "perfDiagnostics") === "available"
  const configured = Boolean(bootstrap?.analytics)
  const { granted, replayOptIn } = effectiveDataSharing(configured, preferences)
  const unavailable = dataSharingUnavailable(configured, granted)

  const [errors, setErrors] = useState<Partial<Record<PrivacyPreference, string>>>({})

  async function save<K extends PrivacyPreference>(key: K, value: UpdateUserPreferencesInput[K]) {
    setErrors((current) => ({ ...current, [key]: undefined }))
    try {
      await updatePreference(key, value, { errorShownInPlace: true })
    } catch (err) {
      const message = ApiError.isApiError(err) ? err.message : "Couldn't save. Try again."
      setErrors((current) => ({ ...current, [key]: message }))
    }
  }

  return (
    <div className="space-y-8">
      <SettingsSection section="encryption">
        <EncryptionKeysSetting />
      </SettingsSection>

      <SettingsSection section="data-sharing">
        <SwitchSetting
          setting="crash-reports"
          checked={granted}
          loading={!bootstrap}
          inactive={unavailable.crashReports?.reason}
          error={errors.analyticsConsent}
          onCheckedChange={(checked) => void save("analyticsConsent", checked ? "granted" : "denied")}
        />
        <SwitchSetting
          setting="session-recording"
          checked={replayOptIn}
          loading={!bootstrap}
          onCheckedChange={(checked) => void save("sessionReplayOptIn", checked)}
          inactive={unavailable.sessionRecording?.reason}
          error={errors.sessionReplayOptIn}
        />
        <SwitchSetting
          setting="device-sharing"
          checked={preferences?.shareDeviceWithAgents !== false}
          error={errors.shareDeviceWithAgents}
          onCheckedChange={(checked) => void save("shareDeviceWithAgents", checked)}
        />
        {diagnosticsOffered && <DiagnosticsSettings />}
      </SettingsSection>
    </div>
  )
}
