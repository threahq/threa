import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { usePreferences } from "@/contexts"
import { useWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { ApiError } from "@/api/client"

export function AnalyticsConsentBanner({ workspaceId }: { workspaceId: string }) {
  const { preferences, updatePreference } = usePreferences()
  const { data: bootstrap } = useWorkspaceBootstrap(workspaceId)
  const [isSubmitting, setIsSubmitting] = useState(false)

  if (preferences?.analyticsConsent !== "unset" || !bootstrap?.analytics) return null

  async function respond(consent: "granted" | "denied") {
    setIsSubmitting(true)
    try {
      await updatePreference("analyticsConsent", consent)
    } catch (err) {
      toast.error(ApiError.isApiError(err) ? err.message : "Failed to update the privacy preference")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      role="region"
      aria-label="Analytics consent"
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-card p-4 shadow-lg sm:inset-x-auto sm:bottom-4 sm:right-4 sm:max-w-sm sm:rounded-lg sm:border"
    >
      <p className="text-sm text-foreground">
        Threa can send crash reports and usage events to PostHog to help us fix bugs. This applies to this workspace
        only and you can change it later under Settings → Privacy.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={isSubmitting} onClick={() => void respond("denied")}>
          Decline
        </Button>
        <Button size="sm" disabled={isSubmitting} onClick={() => void respond("granted")}>
          Allow
        </Button>
      </div>
    </div>
  )
}
