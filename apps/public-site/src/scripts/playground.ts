/*
 * Developer-docs playground runtime.
 *
 * Two jobs:
 *  1. Hold the reader's own credentials (base URL, workspace ID, API key) in
 *     localStorage so every code sample on every page substitutes their real
 *     values in place of the {{baseUrl}} / {{workspaceId}} / {{apiKey}} tokens.
 *     The tokens render as little chips with a tooltip explaining what each is.
 *  2. Actually run the runnable examples against the configured API and print
 *     the response inline, so the docs are a console, not just prose.
 *
 * Everything stays on the reader's device. The API key never leaves the
 * browser except as an Authorization header on requests the reader runs
 * themselves, against the base URL they chose.
 */

type VarName = "baseUrl" | "workspaceId" | "apiKey"

interface Creds {
  baseUrl: string
  workspaceId: string
  apiKey: string
}

const STORAGE_KEY = "threa:dev:creds"
const DEFAULT_BASE_URL = "https://app.threa.io"

const VAR_LABELS: Record<VarName, string> = {
  baseUrl: "API base URL — which Threa deployment your calls hit.",
  workspaceId: "Your workspace ID (looks like ws_…). Find it in the app URL: /w/<workspaceId>.",
  apiKey: "Your API key. Stored only in this browser, sent only on requests you run here.",
}

const VAR_PLACEHOLDERS: Record<VarName, string> = {
  baseUrl: DEFAULT_BASE_URL,
  workspaceId: "ws_your_workspace_id",
  apiKey: "threa_uk_your_api_key",
}

function readCreds(): Creds {
  let stored: Partial<Creds> = {}
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")
  } catch {
    stored = {}
  }
  return {
    baseUrl: stored.baseUrl || DEFAULT_BASE_URL,
    workspaceId: stored.workspaceId || "",
    apiKey: stored.apiKey || "",
  }
}

function writeCreds(creds: Creds): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(creds))
}

function isSet(creds: Creds, name: VarName): boolean {
  return Boolean(creds[name] && creds[name].trim().length > 0)
}

/* What the reader sees in a code sample for a given variable. The API key is
   masked to its prefix + last 4 so a screen-share doesn't leak the secret;
   copy and run still use the real value. */
function displayValue(creds: Creds, name: VarName): string {
  if (!isSet(creds, name)) return VAR_PLACEHOLDERS[name]
  if (name === "apiKey") {
    const k = creds.apiKey
    const head = k.slice(0, k.startsWith("threa_") ? 12 : 4)
    return `${head}…${k.slice(-4)}`
  }
  return creds[name]
}

/* The literal value used when copying or running (never masked). */
function realValue(creds: Creds, name: VarName): string {
  return isSet(creds, name) ? creds[name] : VAR_PLACEHOLDERS[name]
}

function substitute(template: string, creds: Creds): string {
  return template
    .replaceAll("{{baseUrl}}", realValue(creds, "baseUrl"))
    .replaceAll("{{workspaceId}}", realValue(creds, "workspaceId"))
    .replaceAll("{{apiKey}}", realValue(creds, "apiKey"))
}

/* ---- token chips inside code samples ---- */
function hydrateTokens(creds: Creds): void {
  document.querySelectorAll<HTMLElement>("[data-var]").forEach((el) => {
    const name = el.dataset.var as VarName
    if (!name || !(name in VAR_LABELS)) return
    el.textContent = displayValue(creds, name)
    el.dataset.tip = VAR_LABELS[name]
    el.classList.toggle("is-set", isSet(creds, name))
    el.classList.toggle("is-unset", !isSet(creds, name))
  })
}

/* ---- credentials bar ---- */
function setStatus(state: "idle" | "checking" | "ok" | "bad" | "cors", text: string): void {
  const pill = document.getElementById("pg-status")
  if (pill) {
    pill.dataset.state = state
    pill.textContent = text
  }
  // Mirror onto the nav toggle's dot so connection state shows without opening.
  const dot = document.getElementById("pg-dot")
  if (dot) dot.dataset.state = state
}

// Assigned by bindPanel; lets an unset variable chip pop the panel open.
let openPanel: () => void = () => {}

let verifyTimer: ReturnType<typeof setTimeout> | undefined
function scheduleVerify(creds: Creds): void {
  if (verifyTimer) clearTimeout(verifyTimer)
  if (!isSet(creds, "workspaceId") || !isSet(creds, "apiKey")) {
    setStatus("idle", "Not connected")
    return
  }
  setStatus("checking", "Checking…")
  verifyTimer = setTimeout(() => void verify(creds), 450)
}

async function verify(creds: Creds): Promise<void> {
  const url = `${creds.baseUrl}/api/v1/workspaces/${creds.workspaceId}/me`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    })
    if (res.status === 401) return setStatus("bad", "Key rejected")
    if (res.status === 403) return setStatus("bad", "Forbidden")
    if (res.status === 404) return setStatus("bad", "Not found")
    if (!res.ok) return setStatus("bad", `Error ${res.status}`)
    const body = await res.json()
    const principal = body?.data?.kind === "bot" ? "bot" : "user"
    setStatus("ok", `Connected · ${principal}`)
  } catch {
    // A thrown fetch on a cross-origin GET is almost always the API not
    // allow-listing this origin (CORS), not a dead network.
    setStatus("cors", "CORS blocked")
  }
}

function bindCredentialsBar(): void {
  const base = document.getElementById("pg-baseurl") as HTMLInputElement | null
  const ws = document.getElementById("pg-workspace") as HTMLInputElement | null
  const key = document.getElementById("pg-apikey") as HTMLInputElement | null
  const clear = document.getElementById("pg-clear")
  const reveal = document.getElementById("pg-reveal")
  if (!base || !ws || !key) return

  const creds = readCreds()
  base.value = creds.baseUrl
  ws.value = creds.workspaceId
  key.value = creds.apiKey

  const onChange = () => {
    const next: Creds = {
      baseUrl: base.value.trim() || DEFAULT_BASE_URL,
      workspaceId: ws.value.trim(),
      apiKey: key.value.trim(),
    }
    writeCreds(next)
    hydrateTokens(next)
    scheduleVerify(next)
  }
  base.addEventListener("input", onChange)
  ws.addEventListener("input", onChange)
  key.addEventListener("input", onChange)

  clear?.addEventListener("click", () => {
    writeCreds({ baseUrl: DEFAULT_BASE_URL, workspaceId: "", apiKey: "" })
    base.value = DEFAULT_BASE_URL
    ws.value = ""
    key.value = ""
    hydrateTokens(readCreds())
    setStatus("idle", "Not connected")
  })

  reveal?.addEventListener("click", () => {
    const hidden = key.type === "password"
    key.type = hidden ? "text" : "password"
    reveal.textContent = hidden ? "Hide" : "Show"
  })

  scheduleVerify(creds)
}

/* The credentials popover, toggled from the nav. */
function bindPanel(): void {
  const toggle = document.getElementById("pg-toggle")
  const panel = document.getElementById("pg-panel")
  if (!toggle || !panel) return
  panel.removeAttribute("hidden") // JS owns visibility from here via .is-open
  const isOpen = () => panel.classList.contains("is-open")
  const open = () => {
    panel.classList.add("is-open")
    toggle.setAttribute("aria-expanded", "true")
  }
  const close = () => {
    panel.classList.remove("is-open")
    toggle.setAttribute("aria-expanded", "false")
  }
  openPanel = open
  toggle.addEventListener("click", (e) => {
    e.stopPropagation()
    isOpen() ? close() : open()
  })
  document.addEventListener("click", (e) => {
    if (!isOpen()) return
    const t = e.target as Node
    if (!panel.contains(t) && !toggle.contains(t)) close()
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close()
  })
}

/* Explain-on-hover tooltips for the variable chips. One fixed element shared by
   all chips, positioned in JS so it escapes the code block's overflow clipping
   and flips below the chip when it would overlap the sticky nav. */
function bindVarTooltips(): void {
  const tip = document.createElement("div")
  tip.className = "pg-tip"
  document.body.appendChild(tip)
  const NAV_SAFE = 58

  const show = (el: HTMLElement) => {
    const text = el.dataset.tip
    if (!text) return
    tip.textContent = text
    const chip = el.getBoundingClientRect()
    const t = tip.getBoundingClientRect() // size is valid even at opacity 0
    let top = chip.top - t.height - 8
    if (top < NAV_SAFE) top = chip.bottom + 8 // not enough room above → go below
    let left = chip.left
    left = Math.min(left, window.innerWidth - t.width - 8)
    left = Math.max(8, left)
    tip.style.top = `${Math.round(top)}px`
    tip.style.left = `${Math.round(left)}px`
    tip.classList.add("is-on")
  }
  const hide = () => tip.classList.remove("is-on")

  document.addEventListener("pointerover", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-var]")
    if (el) show(el)
  })
  document.addEventListener("pointerout", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-var]")
    if (el) hide()
  })
  // A scroll inside the code block shouldn't leave a stale tooltip behind.
  window.addEventListener("scroll", hide, { passive: true, capture: true })
}

/* Clicking an unset token opens the panel and focuses the field that fills it. */
function bindTokenFocus(): void {
  document.addEventListener("click", (e) => {
    const tok = (e.target as HTMLElement).closest<HTMLElement>("[data-var].is-unset")
    if (!tok) return
    const map: Record<VarName, string> = {
      baseUrl: "pg-baseurl",
      workspaceId: "pg-workspace",
      apiKey: "pg-apikey",
    }
    const id = map[tok.dataset.var as VarName]
    const field = id && document.getElementById(id)
    if (field) {
      openPanel()
      ;(field as HTMLInputElement).focus()
    }
  })
}

/* ---- copy ---- */
function bindCopy(): void {
  document.querySelectorAll<HTMLElement>("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const block = btn.closest(".pg-block")
      const tmpl = block?.querySelector<HTMLElement>("[data-template]")?.dataset.template
      if (!tmpl) return
      await navigator.clipboard.writeText(substitute(tmpl, readCreds()))
      const prev = btn.textContent
      btn.textContent = "Copied"
      setTimeout(() => (btn.textContent = prev), 1200)
    })
  })
}

/* ---- run ---- */
interface RunConfig {
  method: string
  path: string
  body?: string
  multipart?: boolean
}

function renderOutput(out: HTMLElement, kind: "ok" | "err", lines: string): void {
  out.dataset.kind = kind
  out.hidden = false
  out.textContent = lines
}

function bindRun(): void {
  document.querySelectorAll<HTMLElement>("[data-run]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const block = btn.closest(".pg-block")
      const out = block?.querySelector<HTMLElement>(".pg-output")
      if (!out) return
      let cfg: RunConfig
      try {
        cfg = JSON.parse(btn.dataset.run || "{}")
      } catch {
        return
      }
      const creds = readCreds()
      if (!isSet(creds, "workspaceId") || !isSet(creds, "apiKey")) {
        renderOutput(out, "err", "Set your workspace ID and API key above to run this.")
        return
      }
      const url = substitute(cfg.path, creds)
      const headers: Record<string, string> = {
        Authorization: `Bearer ${creds.apiKey}`,
      }
      let body: string | undefined
      if (cfg.body && !cfg.multipart) {
        headers["Content-Type"] = "application/json"
        body = substitute(cfg.body, creds)
      }
      renderOutput(out, "ok", "Running…")
      const started = performance.now()
      try {
        const res = await fetch(url, { method: cfg.method, headers, body })
        const ms = Math.round(performance.now() - started)
        const text = await res.text()
        let pretty = text
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2)
        } catch {
          /* non-JSON (e.g. 204) — show as-is */
        }
        const head = `${cfg.method} ${res.status} ${res.statusText} · ${ms}ms\n\n`
        renderOutput(out, res.ok ? "ok" : "err", head + (pretty || "(empty body)"))
      } catch {
        renderOutput(
          out,
          "err",
          `Request blocked before it returned a response.\n\n` +
            `This is almost always CORS: the API at ${creds.baseUrl} hasn't ` +
            `allow-listed ${location.origin} yet. See Operations → CORS for the ` +
            `one env var that fixes it. The same call works from curl or your own ` +
            `server right now.`
        )
      }
    })
  })
}

/* Highlight the sidebar sub-section link for whatever's currently in view. */
function bindSectionSpy(): void {
  const links = Array.from(document.querySelectorAll<HTMLElement>(".docs-side-sub a[data-section]"))
  if (!links.length) return
  const targets = links
    .map((l) => document.getElementById(l.dataset.section || ""))
    .filter((el): el is HTMLElement => Boolean(el))
  if (!targets.length) return

  let activeId = ""
  // Seed the accordion pointer with whichever group renders open, so jumping
  // straight to another group closes it instead of leaving two open.
  let autoGroup = document.querySelector<HTMLDetailsElement>(".docs-side-sub[data-collapsible] details.dss-group[open]")
  const setActive = (id: string) => {
    if (id === activeId) return
    activeId = id
    links.forEach((l) => l.classList.toggle("active", l.dataset.section === id))
    // Accordion: the group you've scrolled into opens, and the one scrolling
    // opened before it closes — so the list stays compact. Manual toggles of
    // other groups are left alone.
    const group = links.find((l) => l.dataset.section === id)?.closest<HTMLDetailsElement>("details.dss-group") ?? null
    if (group && group !== autoGroup) {
      if (autoGroup) autoGroup.open = false
      group.open = true
      autoGroup = group
    }
  }
  const obs = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (visible.length) setActive((visible[0].target as HTMLElement).id)
    },
    { rootMargin: "-64px 0px -70% 0px", threshold: 0 }
  )
  targets.forEach((t) => obs.observe(t))
}

/* Collapsible sidebar groups (the API reference) use native <details>, so they
   render collapsed without JS and don't flicker. When the page is deep-linked to
   a section, open that section's group (and close the build default). Headers
   toggle natively; the accordion-on-scroll lives in bindSectionSpy. */
function bindSubnavCollapse(): void {
  const sub = document.querySelector<HTMLElement>(".docs-side-sub[data-collapsible]")
  if (!sub) return
  const hashId = location.hash.slice(1)
  if (!hashId) return
  const openGroup = sub
    .querySelector<HTMLElement>(`a[data-section="${CSS.escape(hashId)}"]`)
    ?.closest<HTMLDetailsElement>("details.dss-group")
  if (!openGroup) return
  sub.querySelectorAll<HTMLDetailsElement>("details.dss-group").forEach((g) => {
    g.open = g === openGroup
  })
}

/* Mobile navigation drawer. On narrow viewports the side nav is hidden off
   canvas; the hamburger slides it in. Closing on backdrop tap, link tap, or
   Escape keeps it out of the way once the reader has chosen where to go. */
function bindMobileNav(): void {
  const toggle = document.getElementById("docs-menu-toggle")
  const side = document.getElementById("docs-side")
  const backdrop = document.getElementById("docs-side-backdrop")
  if (!toggle || !side || !backdrop) return
  backdrop.removeAttribute("hidden") // JS owns visibility from here via CSS

  const isOpen = () => document.body.classList.contains("docs-nav-open")
  const open = () => {
    document.body.classList.add("docs-nav-open")
    toggle.setAttribute("aria-expanded", "true")
  }
  const close = () => {
    document.body.classList.remove("docs-nav-open")
    toggle.setAttribute("aria-expanded", "false")
  }

  toggle.addEventListener("click", () => (isOpen() ? close() : open()))
  backdrop.addEventListener("click", close)
  side.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a")) close()
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close()
  })
}

function boot(): void {
  hydrateTokens(readCreds())
  bindPanel()
  bindMobileNav()
  bindCredentialsBar()
  bindVarTooltips()
  bindTokenFocus()
  bindCopy()
  bindRun()
  bindSubnavCollapse()
  bindSectionSpy()
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot)
} else {
  boot()
}
