/**
 * Doc Edit Test Cases
 *
 * Every case runs against the same seeded "Rotation tracker" doc hosted on the
 * scratchpad: a heading, a credential table and a task list. Write cases ask
 * for one targeted change; chitchat and read-only questions must leave it alone.
 */

import type { EvalCase } from "../../framework/types"
import type { DocEditInput, DocEditExpected } from "./types"

export const DOC_BODY = `# Rotation tracker

| Credential | Owner | Last rotated | Verified |
| --- | --- | --- | --- |
| AWS access key | Platform | 2026-06-02 | yes |
| Stripe secret | Payments | 2026-05-20 | yes |

- [ ] Revoke the old AWS access key once the new one is live
- [ ] Rotate the Stripe secret before the next release
`

export const DOC_TITLE = "Rotation tracker"

export const docEditCases: EvalCase<DocEditInput, DocEditExpected>[] = [
  {
    id: "check-aws-task-001",
    name: "Ticks off one task item",
    input: {
      message: "the new AWS key is live now, tick off the revoke item in the rotation tracker",
    },
    expectedOutput: {
      shouldWrite: true,
      touchedSectionMustMatch: /\[x\].*AWS access key/i,
      maxTouchedSections: 1,
      replaceableLine: /AWS access key/i,
    },
  },
  {
    id: "add-github-row-001",
    name: "Adds one table row",
    input: {
      message: "add GitHub token to the rotation tracker, owner is DevEx, not rotated or verified yet",
    },
    expectedOutput: {
      shouldWrite: true,
      touchedSectionMustMatch: /GitHub token/i,
      maxTouchedSections: 1,
    },
  },
  {
    id: "chitchat-001",
    name: "Banter leaves the doc untouched",
    input: { message: "lol the office coffee machine is broken again" },
    expectedOutput: { shouldWrite: false },
  },
  {
    id: "chitchat-question-002",
    name: "A question about the doc leaves it untouched",
    input: { message: "what's in the rotation tracker right now?" },
    expectedOutput: { shouldWrite: false },
  },
]
