import { escapeForRegEx } from "@tiptap/core"
import { findSuggestionMatch, type SuggestionMatch, type Trigger } from "@tiptap/suggestion"

/**
 * Lets a space extend a trigger's query instead of ending it, so a multi-word
 * target is reachable: `#CCH - Threa` finds the scratchpad named "CCH - Threa
 * mention scratchpads", which no single word narrows to.
 *
 * The query only grows while it is still finding something. Each word is
 * admitted on the condition that everything before it already matched, so
 * ordinary prose after a `#` ends the match on its first space exactly as it
 * does today — `#42 was fixed` stops at `#42`, because "42" matches no stream.
 * The last word typed is exempt, so a query that has just gone wrong stays open
 * (showing nothing) and one backspace brings the list back.
 *
 * A markdown heading is the trigger char followed by a space, and a query is
 * never allowed to start with one, so headings can't be confused for a mention
 * however many words follow.
 */
export function withSpacedQuery(
  base: typeof findSuggestionMatch,
  hasMatches: (query: string) => boolean
): typeof findSuggestionMatch {
  return (config: Trigger): SuggestionMatch => spacedMatch(config, hasMatches) ?? base(config)
}

/** Start of the run of trigger chars nearest the caret (`##pi` starts at the first `#`). */
function triggerStart(text: string, char: string): number | null {
  const last = text.lastIndexOf(char)
  if (last < 0) return null
  let start = last
  while (start >= char.length && text.startsWith(char, start - char.length)) start -= char.length
  return start
}

function spacedMatch(config: Trigger, hasMatches: (query: string) => boolean): SuggestionMatch {
  const { char, allowedPrefixes, startOfLine, $position } = config
  const text = $position.nodeBefore?.isText && $position.nodeBefore.text
  if (!text) return null

  const start = triggerStart(text, char)
  if (start === null) return null
  if (startOfLine && start !== 0) return null

  const prefix = text.slice(Math.max(0, start - 1), start)
  if (allowedPrefixes !== null && !new RegExp(`^[${allowedPrefixes.join("")}\0]?$`).test(prefix)) return null

  // Without a space the default matcher already gets this right, including the
  // prefix and doubled-sigil rules it owns.
  const query = text.slice(start + char.length)
  if (!query.includes(" ")) return null

  const term = query.replace(new RegExp(`^(?:${escapeForRegEx(char)})*`), "")
  if (term.startsWith(" ")) return null

  const words = query.split(" ")
  for (let count = 1; count < words.length; count++) {
    if (!hasMatches(words.slice(0, count).join(" "))) return null
  }

  return {
    range: { from: $position.pos - text.length + start, to: $position.pos },
    query,
    text: text.slice(start),
  }
}
