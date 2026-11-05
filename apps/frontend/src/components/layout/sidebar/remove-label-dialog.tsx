import { useState } from "react"
import { Link } from "react-router-dom"
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogDescription,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/components/ui/responsive-alert-dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { useSettingHref } from "@/hooks/use-setting-href"

interface RemoveLabelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  labelName: string
  streamName: string
  /** Called with the choice and whether to persist it as the default behavior. */
  onResolve: (remove: boolean, remember: boolean) => void
}

/**
 * Asked when a labeled stream is dragged out of its label section into a custom
 * section or a different label: keep the old label (it still shows under that
 * label everywhere) or strip it. The "remember" checkbox flips the
 * `labelRemoveOnMove` preference to always/never so the question stops. Mounted
 * conditionally by the parent, so its local checkbox state resets per prompt.
 */
export function RemoveLabelDialog({ open, onOpenChange, labelName, streamName, onResolve }: RemoveLabelDialogProps) {
  const [remember, setRemember] = useState(false)
  const settingsHref = useSettingHref("label-move")

  return (
    <ResponsiveAlertDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveAlertDialogContent>
        <ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogTitle>Remove the “{labelName}” label?</ResponsiveAlertDialogTitle>
          <ResponsiveAlertDialogDescription>
            {streamName} still carries the “{labelName}” label, so it keeps showing under that label. Remove the label,
            or keep it on this stream?
          </ResponsiveAlertDialogDescription>
        </ResponsiveAlertDialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-sm text-muted-foreground">
          <label className="flex min-h-11 items-center gap-2 sm:min-h-0">
            <Checkbox checked={remember} onCheckedChange={(value) => setRemember(value === true)} />
            Remember my choice
          </label>
          {settingsHref && (
            <Link
              to={settingsHref}
              onClick={() => onOpenChange(false)}
              className="flex min-h-11 items-center underline-offset-4 hover:text-foreground hover:underline sm:min-h-0"
            >
              Change in settings
            </Link>
          )}
        </div>

        <ResponsiveAlertDialogFooter>
          <ResponsiveAlertDialogCancel onClick={() => onResolve(false, remember)}>
            Keep label
          </ResponsiveAlertDialogCancel>
          <ResponsiveAlertDialogAction onClick={() => onResolve(true, remember)}>
            Remove label
          </ResponsiveAlertDialogAction>
        </ResponsiveAlertDialogFooter>
      </ResponsiveAlertDialogContent>
    </ResponsiveAlertDialog>
  )
}
