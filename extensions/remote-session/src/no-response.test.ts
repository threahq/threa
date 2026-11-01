import { expect, test } from "bun:test"
import { endsWithNoResponse, isNoResponse, withoutNoResponse } from "./no-response"

test("only a trailing sentinel line counts, and stripping it keeps everything before it", () => {
  const inputs = [
    "THREA_NO_RESPONSE",
    "  THREA_NO_RESPONSE\n",
    "Still rate-limited; nothing to act on.\r\n\r\nTHREA_NO_RESPONSE",
    "THREA_NO_RESPONSE\n\nActually, here is the answer.",
    "Reply THREA_NO_RESPONSE to stay silent.",
  ]

  expect(
    Object.fromEntries(
      inputs.map((text) => [
        text,
        { only: isNoResponse(text), ends: endsWithNoResponse(text), kept: withoutNoResponse(text).trim() },
      ])
    )
  ).toEqual({
    THREA_NO_RESPONSE: { only: true, ends: true, kept: "" },
    "  THREA_NO_RESPONSE\n": { only: true, ends: true, kept: "" },
    "Still rate-limited; nothing to act on.\r\n\r\nTHREA_NO_RESPONSE": {
      only: false,
      ends: true,
      kept: "Still rate-limited; nothing to act on.",
    },
    "THREA_NO_RESPONSE\n\nActually, here is the answer.": {
      only: false,
      ends: false,
      kept: "THREA_NO_RESPONSE\n\nActually, here is the answer.",
    },
    "Reply THREA_NO_RESPONSE to stay silent.": {
      only: false,
      ends: false,
      kept: "Reply THREA_NO_RESPONSE to stay silent.",
    },
  })
})
