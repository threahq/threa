import { Badge } from "@/components/ui/badge"
import { useOverriddenFeatureFlags } from "@/hooks/use-feature-flags"

interface FeatureFlagsTabProps {
  workspaceId: string
}

/**
 * Read-only view of the viewer's feature flags that differ from the default.
 * Flags at their default value are intentionally not listed, and the tab
 * itself is hidden by the dialog when this list is empty — flag state never
 * leaks beyond what is actually enabled for the viewer.
 */
export function FeatureFlagsTab({ workspaceId }: FeatureFlagsTabProps) {
  const flags = useOverriddenFeatureFlags(workspaceId)

  return (
    <div className="space-y-4 p-1">
      <p className="text-sm text-muted-foreground">
        These flags are set to a non-default value for your account. They are managed by Threa and cannot be changed
        here.
      </p>

      {flags.length === 0 ? (
        <p className="text-sm text-muted-foreground">No flags are set on your account.</p>
      ) : (
        <ul className="space-y-3">
          {flags.map(({ key, value, defaultValue }) => (
            <li key={key} className="flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-sm">{key}</div>
                <div className="text-xs text-muted-foreground">Default: {defaultValue}</div>
              </div>
              <Badge variant="secondary" className="font-mono">
                {value}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
