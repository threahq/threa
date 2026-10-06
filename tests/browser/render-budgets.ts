/**
 * Component renders per action, measured against the prod build CI serves.
 * Each tolerance is sized to that action's run-to-run noise.
 * Ratchet rule: a regression above the band needs a PR that justifies it before
 * a baseline goes up; an improvement below the band must lower the baseline to
 * the number the failing test prints.
 */
export const RENDER_BUDGETS = {
  "type 5 characters": { baseline: 1310, tolerance: 0.1 },
  "incoming message in the open stream": { baseline: 1095, tolerance: 0.15 },
  "message in another stream": { baseline: 417, tolerance: 0.25 },
  "switch stream (warm)": { baseline: 4353, tolerance: 0.1 },
} as const

export type RenderBudgetAction = keyof typeof RENDER_BUDGETS
