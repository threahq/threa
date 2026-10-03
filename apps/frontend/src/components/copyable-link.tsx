import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"

const COPY_CONFIRMATION_MS = 2_000

/** A one-time link the user must copy before leaving: the field selects on focus, the button confirms in place. */
export function CopyableLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopyFailed(false)
      setCopied(true)
      window.setTimeout(() => setCopied(false), COPY_CONFIRMATION_MS)
    } catch {
      setCopyFailed(true)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
        <input
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          aria-label={label}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy()}
          aria-label={copied ? "Copied" : "Copy link"}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      {copyFailed && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't copy the link. Select it and copy it yourself.
        </p>
      )}
    </>
  )
}
