/*
 * The quickstart's progress, read from what the reader has stored. Plain JS on
 * purpose: pages/developers/quickstart.astro also inlines this file as a
 * classic script right after the rail, so steps finished on an earlier visit
 * are folded before first paint instead of collapsing under the reader.
 * scripts/guide.ts imports the same functions and owns every later update.
 */

/** @typedef {"key" | "creds" | "me" | "search"} StepId */
/** @typedef {{ baseUrl: string, workspaceId: string, apiKey: string }} Creds */
/**
 * @typedef {{
 *   keyAck?: boolean,
 *   ran?: Partial<Record<"me" | "search", string>>,
 *   notes?: Partial<Record<"me" | "search", string>>,
 * }} GuideState
 * `ran` holds the credentials fingerprint each step last succeeded with.
 */

/** @type {StepId[]} */
export const STEPS = ["key", "creds", "me", "search"]
export const CREDS_KEY = "threa:dev:creds"
export const GUIDE_KEY = "threa:dev:quickstart"

/** @param {string} key */
export function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") || {}
  } catch {
    return {}
  }
}

/** @returns {Creds} */
export function readCreds() {
  const c = readJson(CREDS_KEY)
  return {
    baseUrl: String(c.baseUrl || "https://app.threa.io").trim(),
    workspaceId: String(c.workspaceId || "").trim(),
    apiKey: String(c.apiKey || "").trim(),
  }
}

/** @param {Creds} c */
export const credsReady = (c) => Boolean(c.workspaceId && c.apiKey)

/** @param {Creds} c */
export const fingerprint = (c) => `${c.baseUrl}|${c.workspaceId}|${c.apiKey.slice(-4)}`

/**
 * @param {Creds} creds
 * @param {GuideState} state
 * @returns {Record<StepId, boolean>}
 */
export function doneSteps(creds, state) {
  const ready = credsReady(creds)
  const fp = fingerprint(creds)
  return {
    key: Boolean(state.keyAck || creds.apiKey),
    creds: ready,
    me: ready && state.ran?.me === fp,
    search: ready && state.ran?.search === fp,
  }
}

/** Folds the steps already done. Only the prepaint pass calls this. */
export function foldDoneSteps() {
  const guide = document.querySelector("[data-guide]")
  if (!guide) return
  const done = doneSteps(readCreds(), readJson(GUIDE_KEY))
  const canFindHidden = "onbeforematch" in document.body
  const current = STEPS.find((s) => !done[s])
  for (const id of STEPS) {
    const li = guide.querySelector(`[data-step="${id}"]`)
    if (!li) continue
    li.setAttribute("data-state", done[id] ? "done" : id === current ? "current" : "todo")
    if (!done[id]) continue
    li.setAttribute("data-compact", "")
    if (canFindHidden) li.querySelector("[data-step-body]")?.setAttribute("hidden", "until-found")
  }
}
