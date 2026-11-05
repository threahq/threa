import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Check, CircleAlert, Copy, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SETTING_CONTROL_HEIGHT, SettingNotice } from "@/components/settings/setting-primitives"
import { cn } from "@/lib/utils"
import { SETTING_ICON_BUTTON } from "@/components/settings/setting-text"

const COPIED_SHOWN_MS = 2000

/** A one-time secret: the input frame, since it's text to select and copy. */
export const SECRET_FRAME = "rounded-lg border border-input bg-background p-3"

/** The one moment a freshly created key's secret is visible, for personal and bot keys alike. */
export function NewApiKeyNotice({ name, value, onDismiss }: { name: string; value: string; onDismiss: () => void }) {
  const [shown, setShown] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      toast.error("Couldn't copy the key. Select it and copy it by hand.")
    }
  }

  const showLabel = shown ? "Hide key" : "Show key"
  const copyLabel = copied ? "Copied" : "Copy key"

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium break-all">New key: {name}</p>
        <SettingNotice icon={CircleAlert}>Copy it now. It won&apos;t be shown again.</SettingNotice>
      </div>

      <div className="flex items-center gap-1.5">
        <code className={cn("min-w-0 flex-1 break-all select-all font-mono text-xs", SECRET_FRAME)}>
          {shown ? value : "•".repeat(40)}
        </code>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className={SETTING_ICON_BUTTON}
              aria-label={showLabel}
              onClick={() => setShown(!shown)}
            >
              {shown ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{showLabel}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className={SETTING_ICON_BUTTON}
              aria-label={copyLabel}
              onClick={() => void copy()}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copyLabel}</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" className={SETTING_CONTROL_HEIGHT} onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
