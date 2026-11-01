import { appendFileSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"

// Every PR runs the cheap base: lint, typecheck, unit and integration suites and
// the browser smoke journeys. An area's expensive suites join only when the PR
// touches that area. Main pushes and manual runs take everything.

interface Area {
  name: string
  sources: string[]
  specs: string[]
}

const fe = "apps/frontend/src/"
const be = "apps/backend/src/features/"
const specDir = "tests/browser/"

export const smokeSpec = `${specDir}smoke.spec.ts`

export const areas: Area[] = [
  {
    name: "timeline",
    sources: [
      `${fe}components/timeline/`,
      `${fe}components/message/`,
      `${fe}sync/`,
      `${fe}lib/timeline`,
      `${fe}lib/read-frontier`,
      `${fe}lib/message-grouping`,
      `${fe}lib/mark-read-events`,
      `${fe}lib/auto-read-attention`,
      `${fe}lib/optimistic-sequence`,
      `${fe}hooks/use-timeline`,
      `${fe}hooks/use-scroll`,
      `${fe}hooks/use-unread`,
      `${fe}hooks/use-last-seen`,
      `${fe}hooks/use-auto-mark`,
      `${fe}hooks/use-stream-socket`,
      `${fe}hooks/use-stream-or-draft`,
      `${fe}stores/stream-store`,
      `${fe}stores/apply-window`,
    ],
    specs: [
      "timeline-",
      "infinite-scroll",
      "auto-read",
      "thread-auto-read",
      "unread-marker-open",
      "thread-unread-marker-open",
      "stream-switch-",
      "cold-open",
      "message-run-fold",
      "send-tail",
      "conversation-panel-landing",
      "empty-window",
      "stream-search-cycling",
      "draft-promotion",
      "lazy-row",
      "edit-last-message",
      "initial-reveal",
      "message-reactions",
      "hover-toolbar-position",
      "quote-range",
      "render-budget",
      "reconnect-rehydrate",
      "subscribe-then-bootstrap",
    ],
  },
  {
    name: "composer",
    sources: [
      `${fe}components/composer/`,
      `${fe}components/editor/`,
      `${fe}components/drafts/`,
      `${fe}lib/drafts`,
      `${fe}lib/keep-editor-focus`,
      `${fe}lib/composer-height-storage`,
      `${fe}lib/draft-promotions`,
      `${fe}hooks/use-draft`,
      `${fe}hooks/use-message-queue`,
      `${fe}stores/draft-store`,
      `${fe}stores/compose-overlay-store`,
      `${fe}stores/composer-handoff-store`,
      "packages/prosemirror/",
    ],
    specs: [
      "composer-",
      "rich-text-editing",
      "markdown-shortcuts",
      "emoji-shortcuts",
      "inline-code-boundary-caret",
      "editor-auto-focus",
      "message-send-mode",
      "keyboard-correction",
      "command-arg-picker",
      "stashed-drafts",
      "drafts-modal",
      "draft-sharing-journey",
      "inline-file-upload",
      "panel-composer",
    ],
  },
  {
    name: "threads",
    sources: [`${fe}components/thread/`, `${be}conversations/`],
    specs: ["thread-replies", "nested-thread", "thread-breadcrumbs", "message-share-to-parent"],
  },
  {
    name: "stream-context",
    sources: [
      `${fe}components/stream-context/`,
      `${fe}lib/stream-context/`,
      `${fe}stores/stream-context-store`,
      `${be}stream-context/`,
    ],
    specs: ["stream-context-"],
  },
  {
    name: "calls",
    sources: [
      `${fe}calls/`,
      `${fe}components/call/`,
      `${fe}stores/call-`,
      `${fe}stores/active-calls-`,
      `${fe}stores/incoming-call-`,
      `${be}calls/`,
      `${specDir}fake-cf-runner.ts`,
    ],
    specs: ["calls"],
  },
  {
    name: "docs",
    sources: [`${fe}components/docs/`, `${fe}pages/docs`, `${fe}lib/docs/`, `${be}docs/`],
    specs: ["doc-"],
  },
  {
    name: "panes",
    sources: [
      `${fe}components/layout/pane-`,
      `${fe}components/layout/panel-`,
      `${fe}components/panes/`,
      `${fe}components/board/`,
      `${fe}lib/page-panes`,
      `${fe}lib/pane-`,
      `${fe}lib/panel-`,
      `${fe}pages/panes`,
      `${fe}pages/board`,
    ],
    specs: ["pane-", "panel-", "page-panes", "board-"],
  },
  {
    name: "sidebar",
    sources: [`${fe}components/layout/sidebar/`, `${be}sidebar-config/`],
    specs: ["sidebar-", "inbox-", "new-channel-socket-subscription", "navigation-history"],
  },
  {
    name: "accounts",
    sources: [`${fe}auth/`, `${fe}components/account-switcher/`, `${fe}lib/account-storage`, `${fe}pages/add-account`],
    specs: ["account-"],
  },
  {
    name: "encryption",
    sources: [
      `${fe}lib/crypto/`,
      `${fe}components/encryption/`,
      `${fe}stores/e2e-`,
      "packages/crypto/",
      `${be}e2e-streams/`,
      `${be}user-e2e-keys/`,
    ],
    specs: ["e2e-"],
  },
  {
    name: "agents",
    sources: [`${fe}components/agent-outcomes/`, `${fe}components/trace/`, `${be}agents/`, `${be}agent-outcomes/`],
    specs: ["agent-"],
  },
  {
    name: "aside",
    sources: [`${fe}components/aside/`, `${fe}lib/aside/`, `${fe}stores/aside-store`],
    specs: ["aside-"],
  },
  {
    name: "push",
    sources: [
      `${fe}lib/sw-push`,
      `${fe}components/settings/notifications`,
      `${fe}components/settings/push`,
      `${be}push/`,
    ],
    specs: ["push-"],
  },
  {
    name: "links",
    sources: [`${fe}components/gallery/`, `${be}link-previews/`],
    specs: ["link-"],
  },
  {
    name: "invitations",
    sources: ["apps/control-plane/", `${be}invitations/`],
    specs: ["invitation-flow", "multi-use-invite", "org-workspace-claim", "guest-journey", "invite-command"],
  },
  {
    name: "connections",
    sources: [`${fe}stores/stream-connections`, `${be}stream-connections/`],
    specs: ["stream-connections"],
  },
  {
    name: "personas",
    sources: [`${fe}components/persona-editor/`, `${fe}components/bot-profile/`, `${be}bot-runtimes/`],
    specs: ["persona-", "bot-"],
  },
]

// Specs no area claims run only on main and through `/e2e`.
export const mainOnlySpecs = [
  "action-drawer-overflow-mobile",
  "activity-feed",
  "attachment-stable-urls",
  "code-block-language",
  "code-block-viewer-mobile",
  "conversation-overlay",
  "conversations-pane",
  "dm-lazy-creation",
  "dynamic-naming",
  "entry-load-failure",
  "inline-message-pointer",
  "launch-ancestors",
  "markdown-table-mobile",
  "memo-embed-card",
  "message-reminder-menu",
  "message-share-cross-stream",
  "message-share-range",
  "move-confirm-dialog",
  "perf-capture",
  "phone-navigation",
  "pinch-zoom-mobile",
  "preview-history-recovery",
  "quick-switcher-open-to-side",
  "quote-pill-mobile",
  "saved-reminder",
  "search-input-mobile",
  "stream-description",
  "stream-not-found",
  "sw-bootstrap-staleness",
  "theme-color-scheme",
  "user-journey",
]

// Changing the shared browser harness can break any spec.
const browserHarness = [
  "playwright.config.ts",
  `${specDir}helpers.ts`,
  `${specDir}account-fixtures.ts`,
  `${specDir}global-setup.ts`,
  `${specDir}setup-infra.ts`,
  ".github/workflows/browser-tests.yml",
]

// Changing how CI installs or selects work can break any gated job.
const ciInfra = [
  ".github/workflows/ci.yml",
  "scripts/ci-policy.ts",
  ".github/actions/",
  ".bun-version",
  "package.json",
  "bun.lock",
]

const gates = {
  app_update: [
    `${fe}sw.ts`,
    `${fe}lib/sw-`,
    `${fe}lib/app-update`,
    `${fe}hooks/use-app-update`,
    `${fe}components/app-update-toast`,
    `${fe}pages/app-status`,
    "apps/frontend/vite.config.ts",
    "tests/app-update/",
  ],
  public_site: ["apps/public-site/", "packages/user-guide/", "packages/types/"],
  extensions: ["extensions/", "packages/"],
}

type Gates = Record<keyof typeof gates, boolean>

export interface CiPlan {
  browser: "all" | string[]
  gates: Gates
  reasons: string[]
}

const startsWithAny = (prefixes: string[], file: string) => prefixes.some((prefix) => file.startsWith(prefix))

export function areaSpecs(area: Area, inventory: string[]): string[] {
  return inventory.filter((spec) => startsWithAny(area.specs, spec.slice(specDir.length)))
}

/** `modules` maps every tracked browser test file to its source text. */
export function planCi(input: { eventName: string; changed: string[]; modules: Map<string, string> }): CiPlan {
  const { changed, modules } = input
  if (input.eventName !== "pull_request") {
    return { browser: "all", gates: selectGates(() => true), reasons: [`${input.eventName}: everything`] }
  }
  const inventory = [...modules.keys()].filter((file) => file.endsWith(".spec.ts"))
  if (!inventory.includes(smokeSpec)) throw new Error(`browser inventory lacks ${smokeSpec}`)

  const touch = (prefixes: string[]) => changed.find((file) => startsWithAny(prefixes, file))
  const harness = changed.find((file) => browserHarness.includes(file))
  const infra = touch(ciInfra)
  const touchedAreas = areas.flatMap((area) => {
    const file = touch(area.sources)
    return file ? [{ area, file }] : []
  })
  const specs = new Set([
    smokeSpec,
    ...changed.filter((file) => modules.has(file)).flatMap((file) => dependentSpecs(file, modules)),
    ...touchedAreas.flatMap(({ area }) => areaSpecs(area, inventory)),
  ])

  return {
    browser: harness ? "all" : [...specs].sort(),
    gates: selectGates((prefixes) => infra !== undefined || touch(prefixes) !== undefined),
    reasons: [
      ...(harness ? [`browser harness: ${harness}`] : []),
      ...(infra ? [`ci infrastructure: ${infra}`] : []),
      ...touchedAreas.map(({ area, file }) => `${area.name}: ${file}`),
    ],
  }
}

function selectGates(selected: (prefixes: string[]) => boolean): Gates {
  return Object.fromEntries(Object.entries(gates).map(([gate, prefixes]) => [gate, selected(prefixes)])) as Gates
}

// The changed spec itself, or every spec importing the changed module directly or transitively.
function dependentSpecs(changed: string, modules: Map<string, string>): string[] {
  const reached = new Set([changed])
  for (const file of reached) {
    const specifier = `from "./${path.basename(file, ".ts")}"`
    for (const [importer, source] of modules) if (source.includes(specifier)) reached.add(importer)
  }
  return [...reached].filter((file) => file.endsWith(".spec.ts"))
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" })
}

export function browserModules(): Map<string, string> {
  const files = git(["ls-files", "-z", `${specDir}*.ts`])
    .split("\0")
    .filter(Boolean)
  return new Map(files.map((file) => [file, readFileSync(file, "utf8")]))
}

function pullRequestChanges(): string[] {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8")) as {
    pull_request: { base: { sha: string }; head: { sha: string } }
  }
  const { base, head } = event.pull_request
  const mergeBase = git(["merge-base", base.sha, head.sha]).trim()
  return git(["diff", "--name-only", "-z", "--no-renames", mergeBase, head.sha]).split("\0").filter(Boolean)
}

function main(): void {
  const eventName = process.env.GITHUB_EVENT_NAME
  if (!eventName) throw new Error("GITHUB_EVENT_NAME is not set")

  const changed = eventName === "pull_request" ? pullRequestChanges() : []
  const plan = planCi({ eventName, changed, modules: browserModules() })

  const browser = plan.browser === "all" ? "all" : plan.browser.join(" ")
  const summary = [
    "### CI plan",
    `Browser specs: ${browser}`,
    ...Object.entries(plan.gates).map(([gate, selected]) => `${gate}: ${selected}`),
    ...plan.reasons.map((reason) => `- ${reason}`),
  ].join("\n")
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
  else console.log(summary)

  if (process.env.GITHUB_OUTPUT) {
    const outputs = Object.entries({ browser, ...plan.gates }).map(([key, value]) => `${key}=${value}\n`)
    appendFileSync(process.env.GITHUB_OUTPUT, outputs.join(""))
  }
}

if (import.meta.main) main()
