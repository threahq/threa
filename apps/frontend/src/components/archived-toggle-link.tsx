import { Link } from "react-router-dom"
import { Archive } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** A list page's Archived view toggle: a link to the same page with the archived view flipped (INV-40, INV-59). */
export function ArchivedToggleLink({ to, archived }: { to: string; archived: boolean }) {
  return (
    <Link
      to={to}
      replace
      aria-pressed={archived}
      aria-label="Archived"
      className={cn(
        buttonVariants({ variant: archived ? "secondary" : "ghost", size: "sm" }),
        "relative h-8 shrink-0 gap-1.5 text-xs",
        "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1.5 [@media(pointer:coarse)]:after:content-['']"
      )}
    >
      <Archive className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Archived</span>
    </Link>
  )
}
