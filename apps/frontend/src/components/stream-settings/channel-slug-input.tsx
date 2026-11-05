import { useState, useRef, useCallback, useEffect, useId, type KeyboardEvent, type ReactNode, type Ref } from "react"
import { Loader2, CheckCircle2, XCircle } from "lucide-react"
import { streamsApi } from "@/api/streams"
import { Input } from "@/components/ui/input"
import { SETTING_CONTROL_HEIGHT, SettingFieldError } from "@/components/settings/setting-primitives"
import { cn } from "@/lib/utils"
import { isValidSlug } from "@threahq/types"

type SlugStatus = "idle" | "checking" | "available" | "taken" | "invalid"

interface ChannelSlugInputProps {
  workspaceId: string
  streamId?: string
  currentSlug?: string
  value: string
  onChange: (slug: string) => void
  onValidityChange: (valid: boolean) => void
  disabled?: boolean
  id?: string
  "aria-labelledby"?: string
  inputRef?: Ref<HTMLInputElement>
  onBlur?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  /** Fills the status slot while the slug is unchanged, e.g. a save indicator. */
  indicator?: ReactNode
  /** A save is in flight, so the indicator takes the status slot from the slug check. */
  saving?: boolean
}

export function ChannelSlugInput({
  workspaceId,
  streamId,
  currentSlug,
  value,
  onChange,
  onValidityChange,
  disabled,
  id,
  "aria-labelledby": labelledBy,
  inputRef,
  onBlur,
  onKeyDown,
  indicator,
  saving = false,
}: ChannelSlugInputProps) {
  const [status, setStatus] = useState<SlugStatus>("idle")
  const checkTimer = useRef<ReturnType<typeof setTimeout>>(null)
  const checkAbort = useRef<AbortController>(null)

  const checkSlug = useCallback(
    (slugToCheck: string) => {
      checkAbort.current?.abort()
      const controller = new AbortController()
      checkAbort.current = controller

      setStatus("checking")

      streamsApi
        .checkSlugAvailable(workspaceId, slugToCheck, streamId)
        .then((available) => {
          if (controller.signal.aborted) return
          const newStatus = available ? "available" : "taken"
          setStatus(newStatus)
          onValidityChange(available)
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setStatus("idle")
          onValidityChange(false)
        })
    },
    [workspaceId, streamId, onValidityChange]
  )

  const debouncedCheck = useCallback(
    (slug: string) => {
      if (checkTimer.current) clearTimeout(checkTimer.current)
      checkTimer.current = setTimeout(() => checkSlug(slug), 500)
    },
    [checkSlug]
  )

  useEffect(() => {
    return () => {
      if (checkTimer.current) clearTimeout(checkTimer.current)
      checkAbort.current?.abort()
    }
  }, [])

  const handleChange = (raw: string) => {
    const normalized = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "")
    onChange(normalized)

    if (normalized.length === 0) {
      setStatus("idle")
      onValidityChange(false)
      return
    }

    if (!isValidSlug(normalized)) {
      setStatus("invalid")
      onValidityChange(false)
      return
    }

    // Current slug is always valid (only applies when editing an existing stream)
    if (currentSlug && normalized === currentSlug) {
      setStatus("available")
      onValidityChange(true)
      return
    }

    debouncedCheck(normalized)
  }

  // A value set from outside (a revert, a save landing) is the current slug again: nothing to check.
  const shownStatus = saving || (currentSlug && value === currentSlug) ? "idle" : status

  const errorId = useId()
  let error: string | null = null
  if (shownStatus === "taken") error = "This name is already taken."
  else if (shownStatus === "invalid")
    error = "Start with a letter. Lowercase letters, numbers, hyphens and underscores only."

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm font-medium text-muted-foreground"
        >
          #
        </span>
        <Input
          ref={inputRef}
          id={id}
          aria-labelledby={labelledBy}
          aria-invalid={error ? true : undefined}
          aria-errormessage={error ? errorId : undefined}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          placeholder="channel-name"
          disabled={disabled}
          className={cn("pl-7 pr-9", SETTING_CONTROL_HEIGHT)}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
          {shownStatus === "idle" && indicator}
          {shownStatus === "checking" && (
            <Loader2 aria-hidden className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
          )}
          {shownStatus === "available" && (
            <CheckCircle2 aria-hidden className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          )}
          {error && <XCircle aria-hidden className="h-4 w-4 text-destructive" />}
        </span>
      </div>
      {error && <SettingFieldError id={errorId}>{error}</SettingFieldError>}
    </div>
  )
}
