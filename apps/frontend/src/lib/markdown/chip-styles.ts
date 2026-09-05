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

// Colors match the design system kitchen sink.
export const triggerStyles = {
  user: "bg-[hsl(200_70%_50%/0.1)] text-[hsl(200_70%_50%)]",
  persona: "bg-primary/10 text-primary",
  bot: "bg-green-500/10 text-green-600 dark:text-green-400",
  broadcast: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  channel: "bg-muted text-foreground",
  command: "bg-[hsl(280_60%_55%/0.15)] text-[hsl(280_60%_55%)] font-mono",
  me: "bg-[hsl(200_70%_50%/0.15)] text-primary font-semibold",
}
