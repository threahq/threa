import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Shared visual chrome for every rich link-preview card (GitHub, Linear, generic
 * web). The Linear cards set the bar — soft corner glow keyed to a semantic
 * color, colored state pills, mono identifier tags, an uppercase-label field
 * grid — and these primitives carry that one vocabulary across the other
 * providers so no card type invents a parallel look (INV-35, INV-37).
 */

/** Converts a `#rrggbb` (or bare `rrggbb`) hex to `rgba(...)`, falling back to a neutral slate. */
export function colorWithAlpha(hex: string, alpha: number): string {
  const clean = hex.replace(/^#/, "")
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return `rgba(149, 162, 179, ${alpha})`
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Soft corner glow that gives a card depth and a color identity. Pass a hex
 * `color` for a semantic tint (issue/PR state, brand color); omit it for the
 * golden-thread primary tint shared by stateless cards (commits, generic web).
 * Absolutely positioned, so it never affects layout height (INV-21).
 */
export function AccentGlow({ color }: { color?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -right-10 -top-10 h-24 w-24 rounded-full blur-2xl",
        !color && "bg-primary/10"
      )}
      style={color ? { backgroundColor: colorWithAlpha(color, 0.13) } : undefined}
    />
  )
}

/**
 * Pill that names a status with a color-tinted background and border. Text stays
 * `foreground` (legible across every workspace-defined hue); the optional `dot`
 * carries the raw color for an at-a-glance state signal on providers whose state
 * is semantically load-bearing (GitHub open/merged/closed).
 */
export function StatePill({ color, dot, children }: { color: string; dot?: boolean; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-tight text-foreground shadow-sm"
      style={{ backgroundColor: colorWithAlpha(color, 0.14), borderColor: colorWithAlpha(color, 0.32) }}
    >
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
      {children}
    </span>
  )
}

/** Monospace identifier chip — issue keys (`THR-12`), PR numbers (`#42`), commit SHAs. */
export function MonoTag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-muted/70 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </span>
  )
}

/** Colored label chip (issue/Linear labels). Tints background + border from the label's own hex. */
export function LabelChip({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium text-foreground/80 shadow-sm"
      style={{ backgroundColor: colorWithAlpha(color, 0.12), borderColor: colorWithAlpha(color, 0.28) }}
    >
      {children}
    </span>
  )
}

/** Two-column metadata grid for `Field` cells. */
export function FieldGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-x-4 gap-y-2 text-xs", className)}>{children}</div>
}

/** Uppercase-label / value pair used inside `FieldGrid`. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">{label}</p>
      <div className="mt-0.5 truncate font-medium text-foreground/90">{children}</div>
    </div>
  )
}
