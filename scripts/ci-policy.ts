import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

export interface Change {
  status: string
  path: string
}
export interface CiInput {
  eventName: string
  labels: string[]
  changes: Change[]
  browserInventory: string[]
}
export interface CiPlan {
  mode: "full" | "targeted"
  reason: string
  frontendSources: string[]
  frontendTests: string[]
  browserFiles: string[]
  frontendShards: number[]
  browserShards: number[]
}

const protectedBrowser = [
  "rich-text-editing",
  "markdown-shortcuts",
  "emoji-shortcuts",
  "composer-copy-paste-roundtrip",
  "inline-code-boundary-caret",
  "editor-auto-focus",
  "composer-task-list-inline-image",
  "composer-math",
  "doc-chips",
  "composer-resize-mobile",
  "composer-attachment-tray-mobile",
  "composer-attachment-preview-mobile",
  "composer-foot-mobile",
  "composer-foot-presence-mobile",
  "composer-bottom-spacing",
  "timeline-arrival",
  "auto-read",
  "unread-marker-open",
  "thread-unread-marker-open",
  "thread-auto-read",
  "stream-switch-stability",
  "cold-open-two-states",
  "timeline-anchor-restore",
  "infinite-scroll",
  "timeline-deep-window",
  "message-run-fold",
  "send-tail-stability",
  "panel-composer",
  "composer-tray-overflow-desktop",
].map((name) => `tests/browser/${name}.spec.ts`)

const frontendGuards = [
  "apps/frontend/src/auth/account-reset-coverage.test.ts",
  "apps/frontend/src/components/layout/panel-host.test.ts",
  "apps/frontend/src/lib/no-happy-path-success-toast.test.ts",
  "apps/frontend/src/lib/no-stream-memo-fetch.test.ts",
  "apps/frontend/src/lib/perf/no-direct-performance-marks.test.ts",
]

const owners: { roots: string[]; browser: string[] }[] = [
  {
    roots: [
      "apps/frontend/src/components/settings/notifications-settings.tsx",
      "apps/frontend/src/components/settings/push-actions-section.tsx",
      "apps/frontend/src/components/settings/use-push-test.ts",
    ],
    browser: ["push-notification-settings", "push-receipts", "push-receipts-android"],
  },
  { roots: ["apps/frontend/src/pages/saved.tsx"], browser: ["saved-reminder"] },
  { roots: ["apps/frontend/src/pages/scheduled.tsx"], browser: ["saved-reminder", "message-reminder-menu"] },
  {
    roots: ["apps/frontend/src/components/docs/", "apps/frontend/src/pages/docs.tsx"],
    browser: [
      "doc-activity",
      "doc-browse-files",
      "doc-chips",
      "doc-lists",
      "doc-move",
      "doc-nesting",
      "doc-open-context",
      "doc-pane",
      "doc-section-threads",
      "doc-shares",
      "doc-title",
      "doc-top-level",
      "stream-context-docs",
      "inline-message-pointer",
    ],
  },
  {
    roots: ["apps/frontend/src/components/composer/", "apps/frontend/src/components/editor/"],
    browser: [
      "message-send-mode",
      "edit-last-message",
      "panel-composer",
      "doc-pane",
      "doc-chips",
      "inline-file-upload",
      "code-block-language",
      "quote-range",
      "quote-pill-mobile",
      "keyboard-correction-suggestion",
      "command-arg-picker",
      "drafts-modal",
      "stashed-drafts-keyboard-delete",
      "draft-promotion-stability",
      "draft-sharing-journey",
    ],
  },
  {
    roots: [
      "apps/frontend/src/components/timeline/",
      "apps/frontend/src/components/message/",
      "apps/frontend/src/components/thread/",
    ],
    browser: [
      "initial-reveal",
      "conversation-panel-landing",
      "nested-thread-navigation",
      "thread-replies",
      "message-reactions",
      "inline-message-pointer",
      "message-share-to-parent",
      "message-share-cross-stream",
      "message-share-range",
      "subscribe-then-bootstrap",
      "preview-history-recovery",
      "empty-window-catch-up",
      "reconnect-rehydrate",
      "stream-context-jump-indexed",
      "render-budget",
      "hover-toolbar-position",
      "quote-range",
      "quote-pill-mobile",
      "code-block-viewer-mobile",
      "code-block-language",
      "lazy-row-overlays",
      "thread-breadcrumbs",
      "message-reminder-menu",
      "attachment-stable-urls",
    ],
  },
  {
    roots: ["apps/frontend/src/components/layout/sidebar/"],
    browser: [
      "inbox-sidebar",
      "sidebar-menu-dismissal",
      "sidebar-pick",
      "sidebar-preview",
      "sidebar-section-filter",
      "sidebar-updates",
      "sidebar-hover-card",
      "new-channel-socket-subscription",
      "inbox-modes",
      "navigation-history",
    ],
  },
]

function full(reason: string): CiPlan {
  return {
    mode: "full",
    reason,
    frontendSources: [],
    frontendTests: [],
    browserFiles: [],
    frontendShards: [1, 2, 3, 4, 5, 6],
    browserShards: [1, 2, 3, 4, 5, 6, 7, 8],
  }
}

function isFrontendTest(path: string): boolean {
  return /^apps\/frontend\/src\/.+\.(?:node\.)?test\.tsx?$/.test(path)
}

function isFrontendSource(path: string): boolean {
  return /^apps\/frontend\/src\/.+\.(?:ts|tsx)$/.test(path) && !isFrontendTest(path)
}

function isOwned(path: string, root: string): boolean {
  return root.endsWith("/") ? path.startsWith(root) : path === root
}

export function planCi(input: CiInput): CiPlan {
  if (input.eventName !== "pull_request") return full("non-PR event")
  if (input.labels.includes("ci:full")) return full("ci:full label")
  if (!input.changes.length) return full("empty PR diff")
  if (!input.browserInventory.length || new Set(input.browserInventory).size !== input.browserInventory.length) {
    throw new Error("browser inventory is empty or contains duplicates")
  }
  const inventory = new Set(input.browserInventory)
  const selected = new Set(protectedBrowser)
  const sources = new Set<string>()
  const tests = new Set<string>()
  for (const change of input.changes) {
    if (!/^[AM]$/.test(change.status)) return full(`unsupported change ${change.status}: ${change.path}`)
    if (!change.path || change.path.startsWith("/") || change.path.includes("..")) return full("invalid changed path")
    if (isFrontendTest(change.path)) {
      tests.add(change.path)
    } else if (/^tests\/browser\/[^/]+\.spec\.ts$/.test(change.path)) {
      selected.add(change.path)
    } else if (isFrontendSource(change.path)) {
      const owner = owners.find((entry) => entry.roots.some((root) => isOwned(change.path, root)))
      if (!owner) return full(`unowned frontend source: ${change.path}`)
      sources.add(change.path)
      for (const name of owner.browser) selected.add(`tests/browser/${name}.spec.ts`)
    } else {
      return full(`shared, backend, config or unknown path: ${change.path}`)
    }
  }
  for (const file of selected)
    if (!inventory.has(file)) throw new Error(`selected browser file missing from inventory: ${file}`)
  if (sources.size) for (const guard of frontendGuards) tests.add(guard)
  return {
    mode: "targeted",
    reason: "reviewed frontend changes",
    frontendSources: [...sources].sort(),
    frontendTests: [...tests].sort(),
    browserFiles: [...selected].sort(),
    frontendShards: [1],
    browserShards: [1, 2, 3],
  }
}

export function parseNameStatus(raw: string): Change[] {
  const parts = raw.split("\0")
  if (parts.pop() !== "") throw new Error("incomplete git name-status output")
  const changes: Change[] = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]!
    const path = parts[i++]
    if (!path) throw new Error("incomplete git name-status entry")
    if (/^[RC]/.test(status)) {
      if (!parts[i++]) throw new Error("incomplete git rename/copy entry")
    }
    changes.push({ status, path })
  }
  return changes
}

function option(args: string[], name: string): string {
  const i = args.indexOf(name)
  if (i < 0 || !args[i + 1]) throw new Error(`missing ${name}`)
  return args[i + 1]!
}

function optional(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i < 0 ? undefined : option(args, name)
}

export function main(args = process.argv.slice(2)): void {
  const event = JSON.parse(readFileSync(option(args, "--event"), "utf8")) as {
    pull_request?: { labels?: { name: string }[] }
  }
  const eventName = option(args, "--event-name")
  const inventoryFile = optional(args, "--inventory")
  const inventory = inventoryFile
    ? (JSON.parse(readFileSync(inventoryFile, "utf8")) as string[])
    : execFileSync("git", ["ls-files", "-z", "tests/browser/*.spec.ts"], { encoding: "utf8" })
        .split("\0")
        .filter(Boolean)
  const eventPr = event.pull_request as
    | (typeof event.pull_request & { base?: { sha: string }; head?: { sha: string } })
    | undefined
  let changes: Change[] = []
  if (eventName === "pull_request") {
    const base = optional(args, "--base-sha") ?? eventPr?.base?.sha
    const head = optional(args, "--head-sha") ?? eventPr?.head?.sha
    if (!base || !head) throw new Error("missing PR base/head SHA")
    const mergeBase = execFileSync("git", ["merge-base", base, head], { encoding: "utf8" }).trim()
    if (!mergeBase) throw new Error("no merge base")
    const diff = execFileSync("git", ["diff", "--name-status", "-z", "--find-renames", mergeBase, head], {
      encoding: "utf8",
    })
    changes = parseNameStatus(diff)
  }
  const plan = planCi({
    eventName,
    labels: event.pull_request?.labels?.map((label) => label.name) ?? [],
    changes,
    browserInventory: inventory,
  })
  writeFileSync(option(args, "--json"), `${JSON.stringify(plan, null, 2)}\n`)
  const lines = [
    `### CI policy: ${plan.mode}`,
    `Reason: ${plan.reason}`,
    `Frontend sources: ${plan.frontendSources.join(", ") || "all/none"}`,
    `Frontend tests: ${plan.frontendTests.join(", ") || "all/none"}`,
    `Browser files: ${plan.browserFiles.join(", ") || "all"}`,
  ]
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n\n")}\n`)
  if (process.env.GITHUB_OUTPUT) {
    const outputs = {
      mode: plan.mode,
      full: String(plan.mode === "full"),
      run_frontend: String(plan.mode === "full" || plan.frontendSources.length > 0 || plan.frontendTests.length > 0),
      frontend_sources: JSON.stringify(plan.frontendSources),
      frontend_tests: JSON.stringify(plan.frontendTests),
      browser_files: JSON.stringify(plan.browserFiles),
      frontend_shards: JSON.stringify(plan.frontendShards),
      browser_shards: JSON.stringify(plan.browserShards),
      browser_shard_count: String(plan.browserShards.length),
    }
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join("")
    )
  }
}

if (import.meta.main) main()
