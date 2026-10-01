import type { LucideIcon } from "lucide-react"
import { ThreaLogo } from "@/components/threa-logo"

export function StandalonePage({ children }: { children?: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,hsl(var(--primary)/0.10),transparent_55%)]"
      />
      <div className="relative flex w-full max-w-md flex-col items-center gap-10 p-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <ThreaLogo size="lg" />
        {children}
      </div>
    </div>
  )
}

export function HaloIcon({ icon: Icon, tone = "muted" }: { icon: LucideIcon; tone?: "primary" | "muted" }) {
  const haloClass = tone === "primary" ? "bg-primary/15" : "bg-muted/60"
  const iconClass = tone === "primary" ? "text-primary" : "text-muted-foreground"
  return (
    <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
      <div aria-hidden className={`absolute inset-1 rounded-full ${haloClass} blur-xl`} />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-full border bg-background">
        <Icon className={`h-6 w-6 ${iconClass}`} />
      </div>
    </div>
  )
}
