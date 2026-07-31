import { escapeForRegEx, type Editor } from "@tiptap/core"
import type { PluginKey } from "@tiptap/pm/state"
import { findSuggestionMatch, type SuggestionMatch, type Trigger } from "@tiptap/suggestion"

/**
 * Mobile keyboards insert a picked word suggestion with a leading space when the
 * preceding character is punctuation: `:srig` becomes `: shrug` in a single
 * transaction. The default matcher (allowSpaces: false) then returns null and the
 * popup dies, even though the user is mid-pick.
 *
 * This wrapper falls back to matching `<char> <word>` at the caret, but only when
 * the suggestion was already active before this transaction. A manually typed
 * space deactivates the suggestion on its own transaction, so ordinary text like
 * "ratio : 5" can never reopen the popup — only a multi-character insert landing
 * while the popup is open (the keyboard word-correction) reaches the fallback.
 *
 * Keyboards also append a trailing space (`: shrug `), often as a follow-up
 * transaction, so the pattern tolerates one. Only in the leading-space form: a
 * plain `:fir ` still dismisses, and a second space after a correction dismisses
 * too — the corrected state is the one place a single space can't.
 */
export function withKeyboardCorrectionTolerance(pluginKey: PluginKey, editor: Editor): typeof findSuggestionMatch {
  // Runs during state application, when editor.state still holds the
  // pre-transaction state — so this reads the *previous* active flag.
  const wasActive = () => (pluginKey.getState(editor.state) as { active?: boolean } | undefined)?.active === true

  return (config: Trigger): SuggestionMatch => {
    const match = findSuggestionMatch(config)
    if (match) return match
    if (!wasActive()) return null

    const { char, allowSpaces, allowToIncludeChar, allowedPrefixes, startOfLine, $position } = config
    if (allowSpaces || allowToIncludeChar) return null

    const text = $position.nodeBefore?.isText && $position.nodeBefore.text
    if (!text) return null

    const escapedChar = escapeForRegEx(char)
    const prefix = startOfLine ? "^" : ""
    const corrected = text.match(new RegExp(`${prefix}${escapedChar} [^\\s${escapedChar}]+ ?$`))
    if (!corrected || corrected.index === undefined) return null

    const matchPrefix = text.slice(Math.max(0, corrected.index - 1), corrected.index)
    if (allowedPrefixes !== null && !new RegExp(`^[${allowedPrefixes.join("")}\0]?$`).test(matchPrefix)) {
      return null
    }

    const from = $position.pos - text.length + corrected.index
    return {
      range: { from, to: $position.pos },
      query: corrected[0].slice(char.length + 1).trimEnd(),
      text: corrected[0],
    }
  }
}
