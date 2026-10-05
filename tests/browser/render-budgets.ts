/**
 * Component renders per action, measured against the prod build CI serves.
 * Ratchet rule: a regression above the band needs a PR that justifies it before
 * a baseline goes up; an improvement below the band must lower the baseline to
 * the number the failing test prints.
 */
export const RENDER_BUDGETS = {
  baselines: {
    "type 5 characters": 1700,
    "incoming message in the open stream": 2200,
    "message in another stream": 470,
    "switch stream (warm)": 10950,
  },
  tolerance: 0.25,
} as const

export type RenderBudgetAction = keyof typeof RENDER_BUDGETS.baselines
