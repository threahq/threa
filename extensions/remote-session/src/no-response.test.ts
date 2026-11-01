import { expect, test } from "bun:test"
import { isNoResponse } from "./no-response"

test("the sentinel alone or on the last line silences the reply; elsewhere it is plain text", () => {
  expect(
    [
      "THREA_NO_RESPONSE",
      "  THREA_NO_RESPONSE\n",
      "CodeRabbit is still rate-limited; nothing to act on.\n\nTHREA_NO_RESPONSE",
      "THREA_NO_RESPONSE\n\nActually, here is the answer.",
      "Reply THREA_NO_RESPONSE to stay silent.",
      "",
    ].map(isNoResponse)
  ).toEqual([true, true, true, false, false, false])
})
