import { describe, expect, it } from "bun:test"
import { CONTAINER_NODE_TYPES, LEAF_NODE_TYPES } from "@threahq/prosemirror"
import { BRIDGE_NODE_RULES } from "./export"

describe("BRIDGE_NODE_RULES", () => {
  it("should name a rule for every node type a stored document can hold", () => {
    expect([...BRIDGE_NODE_RULES.keys()].sort()).toEqual([...LEAF_NODE_TYPES, ...CONTAINER_NODE_TYPES].sort())
  })
})
