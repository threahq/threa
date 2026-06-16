import { useCallback, useState } from "react"
import { Copy, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ErrorDetailsProps {
  text: string
  className?: string
}

/**
 * Bounded, scrollable error details with a copy button.
 * Used inside error boundaries so users can capture and share errors.
 */
export function ErrorDetails({ text, className }: ErrorDetailsProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for contexts where clipboard API is unavailable
      const textarea = document.createElement("textarea")
      textarea.value = text
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand("copy")
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [text])

  return (
    <details className={cn("mt-4 w-full max-w-md text-left", className)}>
      <summary className="cursor-pointer text-sm text-muted-foreground">Error details</summary>
      <div className="relative mt-2">
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-1 right-1 h-6 w-6 z-10"
          onClick={handleCopy}
          aria-label="Copy error details"
        >
          {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
        </Button>
        <pre className="max-h-[40vh] overflow-auto rounded bg-muted p-2 pr-8 text-xs whitespace-pre-wrap break-words">
          {text}
        </pre>
      </div>
    </details>
  )
}
