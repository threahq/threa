import type { CommandArgNames } from "./command-list-context"

// A `/name` and the value it takes (`/thinking high`), the grammar both the
// leading command and its flag arguments follow. `(?=\s|$)` keeps the name a
// whole token, so the `/model` in `/model/checkpoints` is a path segment, not a
// command; a value never starts with `/`, so the next flag is never eaten as
// this one's value.
export const COMMAND_TOKEN = /\/([\w-]+)(?:(\s+)([^\s/]\S*))?(?=\s|$)/.source

/** A flag argument found in the text after a command, `to` exclusive. */
export interface CommandArgSpan {
  from: number
  to: number
  /** Flag name without the leading `/`. */
  name: string
  /** The value it takes, present only when the flag advertises that value. */
  value?: string
}

/**
 * The flag arguments a command's own argument list claims out of the text that
 * follows it. Only a value the flag advertises joins its span, so `/spawn claude
 * /thinking fix the bug` claims `/thinking` alone and leaves the session name
 * prose.
 */
export function scanCommandArgs(text: string, args: CommandArgNames): CommandArgSpan[] {
  if (args.flags.size === 0) return []
  const spans: CommandArgSpan[] = []
  const pattern = new RegExp(`(^|\\s)${COMMAND_TOKEN}`, "g")
  let match
  while ((match = pattern.exec(text)) !== null) {
    const [whole, space, name, , taken] = match
    const advertised = args.flags.get(name.toLowerCase())
    if (!advertised) continue
    const value = taken && advertised.has(taken.toLowerCase()) ? taken : undefined
    const from = match.index + space.length
    spans.push({
      from,
      to: from + (value ? whole.length - space.length : name.length + 1),
      name,
      ...(value ? { value } : {}),
    })
  }
  return spans
}

/**
 * The leading positional value in the text after a command chip, when the first
 * word is one the command advertises (`/spawn pi`). Free text — a session name,
 * a prompt — is prose, not an argument.
 */
export function leadingValueSpan(text: string, args: CommandArgNames): { from: number; to: number } | null {
  const match = text.match(/^(\s*)(\S+)/)
  if (!match) return null
  const [, space, word] = match
  if (!args.values.has(word.toLowerCase())) return null
  return { from: space.length, to: space.length + word.length }
}
