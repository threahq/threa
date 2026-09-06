import { useState, useRef, useCallback, useEffect } from "react"
import { Loader2, CheckCircle2, XCircle } from "lucide-react"
import { streamsApi } from "@/api/streams"
import { isValidSlug } from "@threahq/types"

type SlugStatus = "idle" | "checking" | "available" | "taken" | "invalid"

interface ChannelSlugInputProps {
  workspaceId: string
  streamId?: string
  currentSlug?: string
  value: string
  onChange: (slug: string) => void
  onValidityChange: (valid: boolean) => void
}

export function ChannelSlugInput({
  workspaceId,
  streamId,
  currentSlug,
  value,
  onChange,
  onValidityChange,
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

  return (
    <div>
      <div className="flex items-center rounded-input border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ring-offset-background">
        <span className="flex items-center justify-center h-10 w-9 shrink-0 border-r border-input bg-muted/50 rounded-l-input text-sm font-medium text-muted-foreground select-none">
          #
        </span>
        <input
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="channel-name"
          className="flex-1 h-10 bg-transparent px-3 text-sm placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="flex items-center justify-center h-10 w-8 shrink-0">
          {status === "checking" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {status === "available" && <CheckCircle2 className="h-4 w-4 text-green-500" />}
          {status === "taken" && <XCircle className="h-4 w-4 text-destructive" />}
          {status === "invalid" && <XCircle className="h-4 w-4 text-destructive" />}
        </div>
      </div>
      {status === "taken" && <p className="text-xs text-destructive mt-1">This slug is already taken</p>}
      {status === "invalid" && (
        <p className="text-xs text-destructive mt-1">Lowercase letters, numbers, and hyphens only</p>
      )}
    </div>
  )
}
