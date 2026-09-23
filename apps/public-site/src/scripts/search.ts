import {
  highlightRanges,
  prepareIndex,
  search,
  type PreparedEntry,
  type SearchEntry,
  type SearchHit,
} from "../lib/search"

const INDEX_URL = "/developers/search-index.json"
const HIT_KEY = "threa:search-hit"
const FLASH_MS = 1600

let indexPromise: Promise<PreparedEntry[]> | null = null
let indexReady = false
function loadIndex(): Promise<PreparedEntry[]> {
  indexPromise ??= fetch(INDEX_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`search index: HTTP ${res.status}`)
      return res.json() as Promise<SearchEntry[]>
    })
    .then((entries) => {
      indexReady = true
      return prepareIndex(entries)
    })
    .catch((err) => {
      indexPromise = null
      throw err
    })
  return indexPromise
}

const normalizePath = (p: string) => p.replace(/\/+$/, "") || "/"

function flash(el: Element | null): void {
  if (!el) return
  el.classList.remove("search-hit")
  void (el as HTMLElement).offsetWidth
  el.classList.add("search-hit")
  window.setTimeout(() => el.classList.remove("search-hit"), FLASH_MS)
}

function landingTarget(hash: string): Element | null {
  if (!hash) return document.querySelector(".docs-article h1")
  return document.getElementById(decodeURIComponent(hash.slice(1)))
}

function go(url: string): void {
  const target = new URL(url, location.href)
  if (normalizePath(target.pathname) !== normalizePath(location.pathname)) {
    try {
      sessionStorage.setItem(HIT_KEY, target.hash)
    } catch {
      // Without storage the page still opens at the anchor, just without the highlight.
    }
    location.href = target.href
    return
  }
  const el = landingTarget(target.hash)
  if (target.hash && target.hash !== location.hash) location.hash = target.hash
  else if (el && target.hash) el.scrollIntoView()
  else window.scrollTo(0, 0)
  flash(el)
}

function flashArrival(): void {
  let hash: string | null = null
  try {
    hash = sessionStorage.getItem(HIT_KEY)
    sessionStorage.removeItem(HIT_KEY)
  } catch {
    return
  }
  if (hash !== null && hash === location.hash) flash(landingTarget(hash))
}

const KIND_ICON: Record<SearchEntry["kind"], string> = {
  page: '<path d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" />',
  heading: '<path d="M6 2 4.5 14M11.5 2 10 14M2.5 5.5h11M2 10.5h11" />',
  operation: '<path d="M2 8h9M8 4.5 11.5 8 8 11.5M14 3v10" />',
  field:
    '<path d="M5.5 2.5C4 2.5 4 3.5 4 5s-.5 3-2 3c1.5 0 2 1.5 2 3s0 2.5 1.5 2.5M10.5 2.5c1.5 0 1.5 1 1.5 2.5s.5 3 2 3c-1.5 0-2 1.5-2 3s0 2.5-1.5 2.5" />',
}

function marked(text: string, query: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  let at = 0
  for (const [start, end] of highlightRanges(text, query)) {
    frag.append(text.slice(at, start))
    const mark = document.createElement("mark")
    mark.textContent = text.slice(start, end)
    frag.append(mark)
    at = end
  }
  frag.append(text.slice(at))
  return frag
}

function span(className: string, content: string | Node): HTMLSpanElement {
  const el = document.createElement("span")
  el.className = className
  el.append(content)
  return el
}

function renderOption(hit: SearchHit, query: string, id: string): HTMLLIElement {
  const { entry } = hit
  const li = document.createElement("li")
  li.id = id
  li.className = "ds-opt"
  li.setAttribute("role", "option")
  li.setAttribute("aria-selected", "false")
  li.dataset.url = entry.url

  const a = document.createElement("a")
  a.href = entry.url
  a.tabIndex = -1

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  icon.setAttribute("class", "ds-opt-icon")
  icon.setAttribute("viewBox", "0 0 16 16")
  icon.setAttribute("aria-hidden", "true")
  icon.innerHTML = KIND_ICON[entry.kind]

  const body = span(
    "ds-opt-body",
    span(`ds-opt-title${entry.kind === "field" ? " is-code" : ""}`, marked(entry.title, query))
  )
  body.append(span("ds-opt-where", entry.where))

  if (entry.kind === "operation" && entry.method && entry.path) {
    const line = span("ds-opt-path", span(`api-method m-${entry.method.toLowerCase()}`, entry.method))
    line.append(marked(entry.path, query))
    const opId = entry.aliases?.[0]
    if (opId && highlightRanges(entry.title, query).length === 0 && highlightRanges(opId, query).length > 0) {
      line.append(span("ds-opt-opid", marked(opId, query)))
    }
    body.append(line)
  }

  a.append(icon, body)
  li.append(a)
  return li
}

interface Surface {
  input: HTMLInputElement
  list: HTMLElement
  status: HTMLElement
  onClose: () => void
  onResults?: (hasContent: boolean) => void
}

function bindSurface(s: Surface): { render: () => void } {
  let active = -1
  let hits: SearchHit[] = []
  let seq = 0
  const prefix = s.list.id

  const options = () => Array.from(s.list.children) as HTMLElement[]
  const setActive = (i: number) => {
    const opts = options()
    if (!opts.length) {
      active = -1
      s.input.removeAttribute("aria-activedescendant")
      return
    }
    active = (i + opts.length) % opts.length
    opts.forEach((o, j) => o.setAttribute("aria-selected", String(j === active)))
    s.input.setAttribute("aria-activedescendant", opts[active].id)
    opts[active].scrollIntoView({ block: "nearest" })
  }

  const render = async () => {
    const query = s.input.value
    const mine = ++seq
    if (!query.trim()) {
      hits = []
      s.list.replaceChildren()
      s.status.textContent = ""
      s.input.removeAttribute("aria-activedescendant")
      s.onResults?.(false)
      return
    }
    let index: PreparedEntry[]
    if (!indexReady) {
      s.status.textContent = "Loading…"
      s.onResults?.(true)
    }
    try {
      index = await loadIndex()
    } catch {
      if (mine !== seq) return
      s.list.replaceChildren()
      s.status.textContent = "Search couldn't load. Type again to retry."
      s.onResults?.(true)
      return
    }
    if (mine !== seq) return
    hits = search(index, query)
    s.list.replaceChildren(...hits.map((h, i) => renderOption(h, query, `${prefix}-${i}`)))
    s.status.textContent = hits.length ? "" : `No matches for “${query.trim()}”`
    s.onResults?.(true)
    setActive(0)
  }

  s.input.addEventListener("input", render)
  s.input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!hits.length) return
      e.preventDefault()
      setActive(active + (e.key === "ArrowDown" ? 1 : -1))
    } else if (e.key === "Enter") {
      const hit = hits[active]
      if (!hit || s.input.getAttribute("aria-expanded") === "false") return
      e.preventDefault()
      s.onClose()
      go(hit.entry.url)
    } else if (e.key === "Escape") {
      e.preventDefault()
      s.onClose()
    }
  })
  s.list.addEventListener("mousedown", (e) => e.preventDefault())
  s.list.addEventListener("mousemove", (e) => {
    const opt = (e.target as Element).closest<HTMLElement>(".ds-opt")
    const i = opt ? options().indexOf(opt) : -1
    if (i >= 0 && i !== active) setActive(i)
  })
  s.list.addEventListener("click", (e) => {
    const opt = (e.target as Element).closest<HTMLElement>(".ds-opt")
    if (!opt || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    s.onClose()
    go(opt.dataset.url!)
  })

  return { render }
}

const isTyping = (el: Element | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

function boot(): void {
  flashArrival()

  const dialog = document.getElementById("ds-dialog") as HTMLDialogElement | null
  const dialogInput = document.getElementById("ds-dialog-input") as HTMLInputElement | null
  const dialogList = document.getElementById("ds-dialog-list")
  const dialogStatus = document.getElementById("ds-dialog-status")
  const inline = document.getElementById("ds-inline")
  const inlineInput = document.getElementById("ds-inline-input") as HTMLInputElement | null
  const inlineList = document.getElementById("ds-inline-list")
  const inlineStatus = document.getElementById("ds-inline-status")
  if (
    !dialog ||
    !dialogInput ||
    !dialogList ||
    !dialogStatus ||
    !inline ||
    !inlineInput ||
    !inlineList ||
    !inlineStatus
  ) {
    return
  }

  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  document.querySelectorAll(".ds-kbd").forEach((k) => (k.textContent = mac ? "⌘K" : "Ctrl K"))

  let returnFocus: HTMLElement | null = null
  const closeDialog = () => dialog.open && dialog.close()
  const dialogSurface = bindSurface({
    input: dialogInput,
    list: dialogList,
    status: dialogStatus,
    onClose: closeDialog,
  })
  const openDialog = () => {
    if (dialog.open) {
      dialogInput.select()
      return
    }
    returnFocus = document.activeElement as HTMLElement | null
    if (inlineInput.value && !dialogInput.value) dialogInput.value = inlineInput.value
    closeInline()
    dialog.showModal()
    dialogInput.focus()
    dialogInput.select()
    void dialogSurface.render()
    void loadIndex().catch(() => {})
  }
  dialog.addEventListener("close", () => {
    returnFocus?.focus({ preventScroll: true })
    returnFocus = null
  })
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) closeDialog()
  })
  document.getElementById("ds-dialog-close")?.addEventListener("click", closeDialog)
  document.querySelectorAll("[data-search-open]").forEach((b) => b.addEventListener("click", openDialog))

  const setInlineOpen = (open: boolean) => {
    inline.classList.toggle("is-open", open)
    inlineInput.setAttribute("aria-expanded", String(open))
  }
  const closeInline = () => setInlineOpen(false)
  const inlineSurface = bindSurface({
    input: inlineInput,
    list: inlineList,
    status: inlineStatus,
    onClose: closeInline,
    onResults: (hasContent) => setInlineOpen(hasContent && document.activeElement === inlineInput),
  })
  inlineInput.addEventListener("focus", () => {
    void loadIndex().catch(() => {})
    if (inlineInput.value.trim()) void inlineSurface.render()
  })
  inlineInput.addEventListener("blur", closeInline)

  document.addEventListener("keydown", (e) => {
    const cmdK = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k"
    const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(document.activeElement)
    if (!cmdK && !slash) return
    e.preventDefault()
    // Wide screens search in the header field itself; the dialog is for when
    // that field is hidden.
    if (inline.checkVisibility()) {
      inlineInput.focus()
      inlineInput.select()
    } else {
      openDialog()
    }
  })
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot)
} else {
  boot()
}
