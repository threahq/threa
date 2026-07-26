const LEADING_POINTER_TAG = /^\s*\[(msg|attach|memo):/
const TOOL_MARKUP = ["<invoke", "</invoke>", "<parameter name=", "<function_calls>", "</function_calls>"]
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const INDENTED_CODE = /^(?: {4}|\t)/

/**
 * Strips inline spans only where the line's backtick runs pair unambiguously: a
 * run length occurring an odd number of times has a stray delimiter somewhere in
 * it, and positional pairing would then swallow whatever sits between the stray
 * and the next opener — which is exactly how real markup escapes the scan.
 */
function stripInlineSpans(line: string): string {
  const runs: Array<{ start: number; length: number }> = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "`") continue
    const start = i
    while (i < line.length && line[i] === "`") i++
    runs.push({ start, length: i - start })
    i--
  }

  const counts = new Map<number, number>()
  for (const run of runs) counts.set(run.length, (counts.get(run.length) ?? 0) + 1)

  let out = ""
  let cursor = 0
  let index = 0
  while (index < runs.length) {
    const open = runs[index]!
    if ((counts.get(open.length) ?? 0) % 2 !== 0) {
      index++
      continue
    }
    const close = runs.slice(index + 1).find((run) => run.length === open.length)
    if (!close) {
      index++
      continue
    }
    out += line.slice(cursor, open.start) + " "
    cursor = close.start + close.length
    index = runs.indexOf(close) + 1
  }

  return out + line.slice(cursor)
}

function stripCode(content: string): string {
  const out: string[] = []
  let fence: { char: string; length: number } | null = null

  for (const line of content.split("\n")) {
    if (fence) {
      const close = FENCE.exec(line)
      if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.length) fence = null
      out.push(" ")
      continue
    }

    const open = FENCE.exec(line)
    if (open?.[1]) {
      fence = { char: open[1][0]!, length: open[1].length }
      out.push(" ")
      continue
    }

    if (INDENTED_CODE.test(line)) {
      out.push(" ")
      continue
    }

    out.push(stripInlineSpans(line))
  }

  return out.join("\n")
}

export function findInternalSyntax(content: string, options?: { toolNames?: readonly string[] }): string | null {
  if (LEADING_POINTER_TAG.test(content)) {
    return "Your response began with an internal `[msg:…]` context tag. Those tags are input-only metadata — rewrite the reply without it."
  }

  const withoutCode = stripCode(content)
  const markup = TOOL_MARKUP.find((token) => withoutCode.includes(token))
  if (markup) {
    return `Your response contained internal tool-call markup (\`${markup}\`). Tool calls go through the tool interface and are never written into a message. If you meant to show the markup to the user, put it inside a fenced code block.`
  }

  const toolNames = options?.toolNames
  if (toolNames && toolNames.length > 0) {
    for (const match of withoutCode.matchAll(MARKDOWN_LINK)) {
      const target = match[1]
      if (target && toolNames.includes(target)) {
        return `Your response contained a markdown link whose target is the tool name \`${target}\`. Link targets must be real pointer URLs — rewrite the reply without that link.`
      }
    }
  }

  return null
}

/**
 * Turn-level output validation: the built-in guard first, then the caller's own
 * validator. Wired where a turn commits user-visible messages, never onto every
 * `AgentRuntime` host — internal-brief hosts quote evidence legitimately.
 */
export function composeOutputValidator(
  toolNames: readonly string[],
  next?: (content: string) => Promise<string | null> | string | null
): (content: string) => Promise<string | null> {
  return async (content: string) => findInternalSyntax(content, { toolNames }) ?? (await next?.(content)) ?? null
}
