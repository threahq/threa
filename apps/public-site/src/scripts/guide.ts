/*
 * The quickstart page's rail. Each step's state comes from the reader's
 * own progress: a key in Credentials, workspace and key both set, and a 2xx
 * from the step's own Run (the playground announces runs and credential
 * changes as DOM events). Done steps compact down; their bodies stay in the
 * DOM and in find-in-page via hidden="until-found", and stay open where the
 * browser can't search hidden content.
 */

import {
  GUIDE_KEY,
  STEPS,
  credsReady,
  doneSteps,
  fingerprint,
  readCreds,
  readJson,
  type GuideState,
  type StepId,
} from "./guide-progress.js"

interface RunDetail {
  ok: boolean
  status: number
  body: unknown
}

function saveState(state: GuideState): void {
  try {
    localStorage.setItem(GUIDE_KEY, JSON.stringify(state))
  } catch {
    // Storage unavailable: progress still shows for this visit.
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
}

/* ---- what a result means, rendered into the step ---- */

function renderMe(target: HTMLElement, d: RunDetail): string | null {
  target.replaceChildren()
  target.hidden = false
  target.dataset.kind = d.ok ? "ok" : "err"
  if (!d.ok) {
    const msg =
      d.status === 401
        ? "401: the key is missing or invalid. Check it in Credentials."
        : d.status === 0
          ? "No response. The output above says why."
          : `${d.status}: check the workspace ID in Credentials. It's in the app URL, after /w/.`
    target.append(el("p", "gr-line", msg))
    return null
  }
  const data = asRecord(asRecord(d.body).data)
  const kind = data.kind === "bot" ? "bot" : "user"
  const id = String(kind === "bot" ? (data.botId ?? "") : (data.userId ?? ""))
  const version = String(asRecord(data.apiVersion).resolved ?? "")

  const head = el("p", "gr-line")
  head.append(el("strong", undefined, kind === "bot" ? "Connected as a bot." : "Connected as you."))
  head.append(
    " " +
      (kind === "bot"
        ? "The bot acts as itself, in the streams it's been added to."
        : "Messages this key sends show as yours, flagged as sent via the API.")
  )
  const facts = el("dl", "gr-facts")
  const add = (k: string, v: string) => {
    if (!v) return
    facts.append(el("dt", undefined, k), el("dd", undefined, v))
  }
  add("Workspace", String(data.workspaceId ?? ""))
  add(kind === "bot" ? "Bot" : "User", id)
  add("API version", version)
  target.append(head, facts)
  return kind === "bot" ? `Bot ${id}` : `Signed in as ${id}`
}

function renderSearch(target: HTMLElement, d: RunDetail, query: string): string | null {
  target.replaceChildren()
  target.hidden = false
  target.dataset.kind = d.ok ? "ok" : "err"
  if (!d.ok) {
    const msg =
      d.status === 404
        ? "404: the key most likely lacks memos:read. A valid key without the scope gets the same 404 as a missing resource."
        : d.status === 0
          ? "No response. The output above says why."
          : `${d.status}: the output above has the error.`
    target.append(el("p", "gr-line", msg))
    return null
  }
  const rows = Array.isArray(asRecord(d.body).data) ? (asRecord(d.body).data as unknown[]) : []
  const head = el("p", "gr-line")
  if (!rows.length) {
    head.append(el("strong", undefined, "The search works."), ` No memos matched “${query}” in this workspace yet.`)
    target.append(head)
    return "Search works, no matches yet"
  }
  head.append(
    el("strong", undefined, `${rows.length} ${rows.length === 1 ? "memo" : "memos"} matched “${query}”.`),
    " The top one, as it shows in Threa:"
  )
  const first = asRecord(rows[0])
  const memo = asRecord(first.memo)
  const stream = asRecord(first.sourceStream)

  const card = el("div", "recall-memo-card gr-card")
  const icon = el("div", "rmc-icon")
  icon.innerHTML = '<svg><use href="#icon-compass" /></svg>'
  const body = el("div", "rmc-body")
  const kicker = el("div", "rmc-kicker")
  kicker.append(el("span", "k-type", String(memo.knowledgeType ?? "memo")))
  if (typeof stream.name === "string" && stream.name) kicker.append(el("span", "k-tag", `#${stream.name}`))
  body.append(kicker, el("div", "rmc-title", String(memo.title ?? "")))
  const created = typeof memo.createdAt === "string" ? new Date(memo.createdAt) : null
  const meta = el(
    "div",
    "rmc-meta",
    created && !isNaN(created.getTime())
      ? created.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : ""
  )
  card.append(icon, body, meta)
  target.append(head, card)
  return `${rows.length} ${rows.length === 1 ? "memo" : "memos"} found`
}

/* The progress bar pins under the docs top nav, whose height moves with the
   breakpoint and font load. */
function trackNavHeight(): void {
  const nav = document.querySelector<HTMLElement>(".docs-nav")
  if (!nav) return
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--docs-nav-h", `${nav.getBoundingClientRect().height}px`)
  }).observe(nav)
}

function boot(): void {
  const guide = document.querySelector<HTMLElement>("[data-guide]")
  if (!guide) return
  trackNavHeight()
  const steps = new Map<StepId, HTMLElement>()
  guide.querySelectorAll<HTMLElement>("[data-step]").forEach((li) => steps.set(li.dataset.step as StepId, li))
  const status = guide.querySelector<HTMLElement>("[data-guide-status]")
  const credsLine = guide.querySelector<HTMLElement>("[data-guide-creds]")
  const canFindHidden = "onbeforematch" in document.body

  // Steps finished during this visit stay open so their result is readable;
  // steps done on an earlier visit compact.
  const open = new Set<StepId>()
  let state: GuideState = readJson(GUIDE_KEY)

  let wasReady = credsReady(readCreds())
  let exampleFound = false

  // The meter follows reading position: a step's segment fills as the page
  // scrolls through it, so every segment is full at the bottom of the page.
  // Completion shows on the rail itself.
  const segs = STEPS.map((id) => guide.querySelector<HTMLElement>(`[data-seg="${id}"]`))
  let readFrame = 0
  const trackReading = () => {
    if (readFrame) return
    readFrame = requestAnimationFrame(() => {
      readFrame = 0
      const root = document.documentElement
      const maxY = Math.max(0, root.scrollHeight - innerHeight)
      const y = Math.min(scrollY, maxY)
      const offset = parseFloat(getComputedStyle(guide).getPropertyValue("--guide-bar-h")) || 0
      const navH = parseFloat(root.style.getPropertyValue("--docs-nav-h")) || 0
      const starts = STEPS.map((id, i) => {
        const li = steps.get(id)
        if (i === 0 || !li) return 0
        return Math.min(maxY, li.getBoundingClientRect().top + scrollY - navH - offset - 16)
      })
      let reading = 0
      STEPS.forEach((_, i) => {
        const start = starts[i]
        const end = i + 1 < starts.length ? starts[i + 1] : maxY
        const fill = end > start ? Math.min(1, Math.max(0, (y - start) / (end - start))) : y >= start ? 1 : 0
        segs[i]?.style.setProperty("--fill", String(fill))
        if (y >= start) reading = i
      })
      if (!status) return
      const title = steps.get(STEPS[reading])?.querySelector("h2")?.textContent ?? ""
      status.textContent = guide.hasAttribute("data-complete")
        ? "All four steps done."
        : `Step ${reading + 1} of ${STEPS.length}: ${title}`
    })
  }
  addEventListener("scroll", trackReading, { passive: true })
  new ResizeObserver(trackReading).observe(document.body)

  const render = () => {
    const creds = readCreds()
    const ready = credsReady(creds)
    // Credentials completed during this visit: keep the step open so its
    // confirmation line stays readable.
    if (ready && !wasReady) open.add("creds")
    wasReady = ready
    const done = doneSteps(creds, state)
    const current = STEPS.find((s) => !done[s]) ?? null

    STEPS.forEach((id) => {
      const li = steps.get(id)
      if (!li) return
      const st = done[id] ? "done" : id === current ? "current" : "todo"
      li.dataset.state = st
      const compact = st === "done" && !open.has(id)
      li.toggleAttribute("data-compact", compact)
      const body = li.querySelector<HTMLElement>("[data-step-body]")
      if (body && canFindHidden) {
        if (compact) body.setAttribute("hidden", "until-found")
        else body.removeAttribute("hidden")
      }
      const toggle = li.querySelector<HTMLButtonElement>("[data-step-toggle]")
      if (toggle) {
        toggle.hidden = st !== "done" || !canFindHidden
        toggle.textContent = compact ? "Show" : "Hide"
        toggle.setAttribute("aria-expanded", String(!compact))
      }
      const note = li.querySelector<HTMLElement>("[data-done-note]")
      if (note) {
        let text = ""
        if (st === "done") {
          if (id === "key") text = creds.apiKey ? `${creds.apiKey.slice(0, 9)}…${creds.apiKey.slice(-4)}` : "Ready"
          if (id === "creds") text = creds.workspaceId
          if (id === "me" || id === "search") text = state.notes?.[id] ?? ""
        }
        note.textContent = text
      }
      // A live /me result replaces the example response; find-in-page still reaches it.
      if (id === "me" && canFindHidden) {
        const expect = li.querySelector<HTMLElement>(".expect")
        if (expect) {
          if (done.me && !exampleFound) expect.setAttribute("hidden", "until-found")
          else expect.removeAttribute("hidden")
        }
      }
    })
    guide.toggleAttribute("data-complete", !current)
    trackReading()

    if (credsLine) {
      credsLine.textContent = ready
        ? `Set for ${creds.workspaceId}. Samples on every page now use it.`
        : creds.apiKey
          ? "Key set. Add the workspace ID."
          : creds.workspaceId
            ? "Workspace set. Add the key."
            : "Nothing set yet."
      credsLine.dataset.ready = String(ready)
    }
  }

  document.addEventListener("threa:creds", render)

  guide.addEventListener("threa:run", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("[data-step]")
    const id = li?.dataset.step
    if (!li || (id !== "me" && id !== "search")) return
    const detail = (e as CustomEvent<RunDetail>).detail
    const target = li.querySelector<HTMLElement>("[data-guide-result]")
    if (!target) return
    let note: string | null
    if (id === "me") {
      note = renderMe(target, detail)
    } else {
      const run = li.querySelector<HTMLElement>("[data-run]")?.dataset.run ?? "{}"
      let query = ""
      try {
        query = String(JSON.parse(JSON.parse(run).body ?? "{}").query ?? "")
      } catch {
        query = ""
      }
      note = renderSearch(target, detail, query)
    }
    if (note !== null) {
      state = {
        ...state,
        ran: { ...state.ran, [id]: fingerprint(readCreds()) },
        notes: { ...state.notes, [id]: note },
      }
      saveState(state)
      open.add(id)
    }
    render()
  })

  guide.addEventListener("click", (e) => {
    const t = e.target as HTMLElement
    if (t.closest("[data-guide-ack]")) {
      state = { ...state, keyAck: true }
      saveState(state)
      render()
      return
    }
    if (t.closest("[data-guide-open-creds]")) {
      // The credentials popover closes on any click outside it; this one opened it.
      e.stopPropagation()
      document.getElementById("pg-toggle")?.click()
      return
    }
    const toggle = t.closest<HTMLElement>("[data-step-toggle]")
    if (toggle) {
      const id = toggle.closest<HTMLElement>("[data-step]")?.dataset.step as StepId | undefined
      if (!id) return
      if (open.has(id)) open.delete(id)
      else open.add(id)
      render()
    }
  })

  // Find-in-page revealed a compacted step: keep it open.
  guide.addEventListener(
    "beforematch",
    (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-step]")?.dataset.step as StepId | undefined
      if ((e.target as HTMLElement).classList.contains("expect")) exampleFound = true
      if (id) {
        open.add(id)
        queueMicrotask(render)
      }
    },
    true
  )

  render()
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot)
} else {
  boot()
}
export {}
