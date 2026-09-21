import { describe, expect, test } from "bun:test"
import { isInboundWebhookUrl, isSlackWebhookUrl } from "./inbound-handlers"

const NATIVE = "/api/v1/workspaces/ws_01W/hooks/hook_01H/s3cr3t"

describe("isInboundWebhookUrl", () => {
  const cases: Array<[name: string, url: string, expected: boolean]> = [
    ["should match when given the native url", NATIVE, true],
    ["should match when given the slack url", `${NATIVE}/slack`, true],
    ["should match when given a trailing slash", `${NATIVE}/slack/`, true],
    ["should match when given a query string", `${NATIVE}?retry=1`, true],
    ["should match when given mixed case, which express routes anyway", "/API/v1/workspaces/w/HOOKS/h/s/SLACK", true],
    ["should not match when given a streams url", "/api/v1/workspaces/ws_01W/streams/stream_01S/messages", false],
    ["should not match when given an unknown suffix", `${NATIVE}/other`, false],
    ["should not match when given a hook url with no secret", "/api/v1/workspaces/ws_01W/hooks/hook_01H", false],
    ["should not match when given a prefix of the api surface", "/api/v1/workspaces", false],
    ["should not match when the path only contains a hook url", `/other${NATIVE}`, false],
    ["should not match when the secret carries an encoded slash", `${NATIVE}%2Fslack/x`, false],
  ]

  for (const [name, url, expected] of cases) {
    test(name, () => {
      expect(isInboundWebhookUrl(url)).toBe(expected)
    })
  }
})

describe("isSlackWebhookUrl", () => {
  const cases: Array<[name: string, url: string, expected: boolean]> = [
    ["should be true when given the slack suffix", `${NATIVE}/slack`, true],
    ["should be true when given the slack suffix with a query string", `${NATIVE}/slack?x=1`, true],
    ["should be true when given an uppercase slack suffix", `${NATIVE}/SLACK`, true],
    ["should be false when given the native url", NATIVE, false],
    ["should be false when the secret merely ends in the word slack", "/api/v1/workspaces/w/hooks/h/abcslack", false],
    ["should be false when given a non-hook url", "/api/v1/workspaces/w/streams/s/messages", false],
  ]

  for (const [name, url, expected] of cases) {
    test(name, () => {
      expect(isSlackWebhookUrl(url)).toBe(expected)
    })
  }
})
