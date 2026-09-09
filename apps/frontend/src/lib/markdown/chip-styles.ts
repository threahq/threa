/**
 * The inline-chip vocabulary shared by every trigger surface: `@` mentions, `/`
 * commands, `#` stream links, and the in-app link chip that `#` now renders
 * through. Its own module because both the renderer that parses chips out of
 * markdown and the component that draws them need it, and either owning it
 * would make the other a cycle.
 */

// No text-sm / font-medium sizing beyond this: a chip inherits size and weight
// from the run it sits in (headers, bold). `inline`, not `inline-flex`, so
// strikethrough and underline propagate through it.
export const chipBase = "inline px-1 py-px rounded font-medium"

/**
 * The `/command` look — the gold code chip, shared by the composer's command
 * node, the chip a posted message renders, and the command lifecycle event, so
 * one command reads the same in all three. Sizing stays with each surface.
 */
export const commandChipStyle = "bg-muted text-primary font-mono font-bold"

/**
 * A flag argument of the command a message opens with (`/spawn claude /model
 * opus`): same gold family, unbolded, so the dispatched command still leads.
 */
export const commandFlagChipStyle = "bg-muted text-primary font-mono"

/**
 * The value a command or flag takes, drawn INSIDE that chip (`/thinking low` is
 * one block): neutral and unbolded against the same gold background, so gold
 * reads as what dispatches and plain as what it dispatches with.
 */
export const commandValueStyle = "text-foreground font-normal"

// Colors match the design system kitchen sink.
export const triggerStyles = {
  user: "bg-[hsl(200_70%_50%/0.1)] text-[hsl(200_70%_50%)]",
  persona: "bg-primary/10 text-primary",
  bot: "bg-green-500/10 text-green-600 dark:text-green-400",
  broadcast: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  channel: "bg-muted text-foreground",
  command: commandChipStyle,
  commandFlag: commandFlagChipStyle,
  me: "bg-[hsl(200_70%_50%/0.15)] text-primary font-semibold",
}
