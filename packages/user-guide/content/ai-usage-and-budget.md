---
title: AI usage and budget
summary: How to read the AI Usage & Budget page and how workspace admins set the monthly budget, per-member limits and guardrails.
section: workspace
order: 5
---

# AI usage and budget

The **AI Usage & Budget** page shows what AI has cost the workspace this month and holds the controls that cap it. Open it from **AI Usage** in the workspace menu at the bottom of the sidebar.

## Who can see and change it

Any member can open the page and read the workspace figures, including each member's assistant spend. Workspace admins change the budget, the guardrails and per-member limits. The server refuses those changes from anyone else.

## Reading the page

- The header summarizes budget health: **Spent**, **Projected**, **Daily avg** and **Days remaining**, plus the billing cycle dates. The projection is a straight-line estimate (spend so far divided by days elapsed, times days in the cycle), so treat it as a ballpark.
- **Daily spend** charts the month day by day.
- **Where the cost comes from** breaks spend down by capability and by model.
- **Where the spend is going** splits cost between **System** and **Assistant**.
- **Assistant usage by member** ranks members by assistant spend this cycle.

The cycle is a calendar month. The **Reporting timezone** selector at the top switches the month boundaries between **Your timezone** and **Workspace timezone**. Admins set the workspace timezone in [Workspace general settings](/guide/workspace-general-settings).

## Budget and guardrails (admins)

The **Budget & guardrails** panel holds these controls:

- **Monthly budget**: a hard monthly limit in dollars. A workspace starts at $50. Edit the amount and leave the field to save it. Threa also applies its own ceiling to each workspace; if that ceiling is lower than your budget, the panel says so and the stop points use the lower amount.
- **Turn off AI**: stops every AI feature for everyone in the workspace.
- **Keep AI on regionally-runnable models**: when on, AI only picks models Threa can run in the workspace's region. When off, AI picks the best model for each job, including models that can only run in one region.
- **Default agent allowance per person**: monthly agent spend for anyone without their own allowance. Leave it empty for no default.
- **Alert thresholds**: switches for **Halfway** (50%), **Approaching limit** (80%) and **Budget exhausted** (100%). All three are on by default.

As spend approaches the limit, AI stops in stages. Agents stop at 70% of the limit, background AI winds down after that, and everything stops at 100%. The panel shows the dollar amounts for your budget.

## Limits for one member (admins)

In **Assistant usage by member**, the sliders button next to a name (labelled **Edit AI limits for** that member) opens **AI limits for** that member. Members who are not in the list yet can be picked with **Set limits for another member**. The dialog has three settings, and each amount is monthly:

- **Total AI max**: a cap on all AI use by this member. Empty means no limit.
- **Agent allowance**: a cap on agent spend. Empty uses the workspace default.
- **Turn off AI**: stops every AI feature for this person.

**Reset to defaults** removes the member's own limits.

To control which models agents can delegate to, and so what delegating costs, see [Managing AI agents](/guide/workspace-ai-agents).
