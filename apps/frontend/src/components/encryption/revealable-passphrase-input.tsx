import { forwardRef, useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type RevealablePassphraseInputProps = Omit<React.ComponentProps<"input">, "type">

/**
 * Passphrase input with an inline eye-toggle. Mobile users typing the 10+ char
 * passphrase need to see what they're entering to avoid lockout from typos
 * they can't see — the masked default still wins on shoulder-surfing surfaces.
 *
 * The toggle is `tabIndex={-1}` so keyboard users tab straight from passphrase
 * to confirm without a detour through the reveal button.
 */
export const RevealablePassphraseInput = forwardRef<HTMLInputElement, RevealablePassphraseInputProps>(
  ({ className, ...props }, ref) => {
    const [revealed, setRevealed] = useState(false)
    return (
      <div className="relative">
        <Input ref={ref} type={revealed ? "text" : "password"} className={cn("pr-10", className)} {...props} />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? "Hide passphrase" : "Show passphrase"}
          aria-pressed={revealed}
          className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center rounded-r-input text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    )
  }
)
RevealablePassphraseInput.displayName = "RevealablePassphraseInput"
