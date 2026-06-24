import {
  PI_TOOL_TRACE_FORMAT,
  PI_TOOL_TRACE_SECTION_LABELS,
  PiToolTraceSectionLabels,
  type PiToolTraceSectionLabel,
} from "@threa/types"

const SENSITIVE_VALUE_PATTERNS = [
  /\b(?:sk|rk|pk|lf|wos|gh[a-z]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:Authorization|X-Api-Key|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;\"'}]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

function redactSensitiveText(text: string): string {
  let redacted = text
  for (const pattern of SENSITIVE_VALUE_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]")
  return redacted
}

export function sanitizeStatusText(statusText?: string | null): string | null {
  const trimmed = redactSensitiveText(statusText?.trim() ?? "")
  if (!trimmed) return null
  const allowed = new Set([
    "Thinking…",
    "Loaded context…",
    "Running shell command…",
    "Reading file…",
    "Reading sensitive file…",
    "Writing file…",
    "Editing file…",
    "Searching files…",
    "Listing directory…",
    "Using tool…",
    "Tool finished",
    "Tool failed",
    "Working…",
    "Composing response…",
    "Sent response",
  ])
  if (allowed.has(trimmed)) return trimmed
  return "Working…"
}

const TRACE_HEADLINE_MAX_CHARS = 200
const TRACE_BODY_MAX_CHARS = 10_000
const TRACE_LANG_MAX_CHARS = 32
const TRACE_MAX_SECTIONS = 16

const TRACE_SECTION_LABEL_SET: ReadonlySet<string> = new Set(PI_TOOL_TRACE_SECTION_LABELS)

interface SafeTraceSection {
  label: PiToolTraceSectionLabel
  body: string
  lang: string | null
}

function clampString(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function sanitizeTraceSection(section: unknown): SafeTraceSection | null {
  if (!section || typeof section !== "object" || Array.isArray(section)) return null
  const item = section as Record<string, unknown>
  const rawLabel = typeof item.label === "string" ? item.label : ""
  if (!TRACE_SECTION_LABEL_SET.has(rawLabel)) return null
  const label = rawLabel as PiToolTraceSectionLabel
  if (label === PiToolTraceSectionLabels.ARGUMENTS) {
    return { label, body: "Tool arguments omitted for safety.", lang: null }
  }
  if (label === PiToolTraceSectionLabels.OUTPUT || label === PiToolTraceSectionLabels.ERROR_OUTPUT) {
    return { label, body: "Tool output omitted for safety.", lang: null }
  }
  const body = typeof item.body === "string" ? clampString(redactSensitiveText(item.body), TRACE_BODY_MAX_CHARS) : ""
  const lang = typeof item.lang === "string" ? clampString(item.lang, TRACE_LANG_MAX_CHARS) : null
  return { label, body, lang }
}

// Trace step content is stored as-received from the bot runtime, after
// best-effort sanitization. The official Pi extension is the security
// boundary — it is responsible for never forwarding raw tool stdout, file
// contents, or credentials. Third-party runtimes inherit the trust level
// of the API key holder; the allowlist + regex here is defense-in-depth,
// not a guarantee. Do not loosen this (relax the allowlist, drop the
// length caps, or pass arbitrary fields through) without revisiting the
// threat model — see extensions/pi-remote/ for the trusted-runtime
// contract.
export function sanitizeInvocationStepContent(content: string): string {
  const redacted = redactSensitiveText(content)
  try {
    const parsed = JSON.parse(redacted) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return redacted
    const trace = parsed as Record<string, unknown>
    if (trace.format !== PI_TOOL_TRACE_FORMAT || !Array.isArray(trace.sections)) return redacted
    const headline =
      typeof trace.headline === "string"
        ? clampString(redactSensitiveText(trace.headline), TRACE_HEADLINE_MAX_CHARS)
        : ""
    const sections = trace.sections
      .slice(0, TRACE_MAX_SECTIONS)
      .map(sanitizeTraceSection)
      .filter((section): section is SafeTraceSection => section !== null)
    return JSON.stringify({ format: PI_TOOL_TRACE_FORMAT, headline, sections })
  } catch {
    return redacted
  }
}
