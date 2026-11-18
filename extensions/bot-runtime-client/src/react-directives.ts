export interface ReactDirective {
  emoji: string
  messageId: string
  remove?: boolean
}

/** Lines `THREA_REACT: msg_id <emoji>` and `THREA_UNREACT: msg_id <emoji>` ask the runtime to react to (or un-react from) a message. A line without a message id is not a directive and stays in the text. */
const REACT_DIRECTIVE_RE = /^ {0,3}THREA_(UN)?REACT:\s*(.*?)\s*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

interface Fence {
  char: string
  length: number
}

/** The fence a line opens or closes, if it is one; a backtick fence's info string cannot hold a backtick. */
function fenceOf(line: string): (Fence & { info: string }) | null {
  const match = line.match(FENCE_RE)
  if (!match) return null
  const marker = match[1]!
  const info = match[2]!.trim()
  if (marker[0] === "`" && info.includes("`")) return null
  return { char: marker[0]!, length: marker.length, info }
}

/**
 * Strip reaction directive lines (outside code fences) out of a message, returning the remaining text and the
 * directives. Only the directive lines and the blank line their removal leaves are dropped, plus blank lines at either end.
 */
export function parseReactDirectives(text: string): { text: string; reactions: ReactDirective[] } {
  const reactions: ReactDirective[] = []
  const kept: string[] = []
  let fence: Fence | null = null
  let afterRemoval = false
  for (const line of text.split("\n")) {
    const marker = fenceOf(line)
    if (fence) {
      if (marker && marker.char === fence.char && marker.length >= fence.length && marker.info === "") fence = null
      kept.push(line)
      continue
    }
    if (marker) {
      fence = marker
      kept.push(line)
      afterRemoval = false
      continue
    }
    const match = line.match(REACT_DIRECTIVE_RE)
    const directive = match ? toDirective(match[1] === "UN", match[2]!) : null
    if (directive) {
      reactions.push(directive)
      afterRemoval = true
      continue
    }
    if (afterRemoval && line.trim() === "" && kept.at(-1)?.trim() === "") continue
    afterRemoval = false
    kept.push(line)
  }
  if (reactions.length === 0) return { text, reactions }
  let start = 0
  let end = kept.length
  while (start < end && kept[start]!.trim() === "") start++
  while (end > start && kept[end - 1]!.trim() === "") end--
  return { text: kept.slice(start, end).join("\n"), reactions }
}

function toDirective(remove: boolean, rest: string): ReactDirective | null {
  const match = rest.match(/^(msg_\S+)\s+(\S+)$/)
  if (!match || match[2]!.startsWith("msg_")) return null
  return { emoji: match[2]!, messageId: match[1]!, ...(remove ? { remove: true } : {}) }
}
