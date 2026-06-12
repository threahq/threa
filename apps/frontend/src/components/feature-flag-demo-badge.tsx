import { useFeatureFlag } from "@/hooks/use-feature-flags"

/**
 * TEMPORARY verification surface for the feature-flag pipeline: renders a
 * small pill while the `demo-banner` flag is set to "on" for the viewer, so
 * changing the flag in the backoffice is visible here within a second — no
 * reload. Delete this component together with the `demo-banner` registry key
 * once a real flag exists.
 */
export function FeatureFlagDemoBadge({ workspaceId }: { workspaceId: string }) {
  const value = useFeatureFlag(workspaceId, "demo-banner")
  if (value !== "on") return null

  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-50 rounded-full border bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm">
      demo-banner flag is on
    </div>
  )
}
