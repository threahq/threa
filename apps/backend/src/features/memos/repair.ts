import { createJsonRepair, type SemanticFieldMapping } from "@threa/agent-runtime"

const MEMO_SEMANTIC_FIELD_MAPPINGS: Record<string, SemanticFieldMapping> = {
  // "classification: not_knowledge_worthy" → "isKnowledgeWorthy: false"
  classification: {
    field: "isKnowledgeWorthy",
    transform: (v) => typeof v === "string" && !v.toLowerCase().includes("not"),
  },
  // "preserve: false" → "isKnowledgeWorthy: false"
  preserve: { field: "isKnowledgeWorthy" },
  // "isKnowledgeWorthPreserving: false" → "isKnowledgeWorthy: false"
  isKnowledgeWorthPreserving: { field: "isKnowledgeWorthy" },
  // "reason: ..." → "reasoning: ..."
  reason: { field: "reasoning" },
  // "recommendation: do_not_preserve" → we don't need this field, but don't want it to fail
  recommendation: { field: "_recommendation" },
}

function addMemoDefaults(obj: Record<string, unknown>): Record<string, unknown> {
  // Normalize knowledgeType to lowercase (models sometimes return "Decision" instead of "decision")
  if ("knowledgeType" in obj && typeof obj.knowledgeType === "string") {
    obj.knowledgeType = obj.knowledgeType.toLowerCase()
  }

  // For message classification: if isGem is false, knowledgeType should be null
  if ("isGem" in obj && obj.isGem === false) {
    if (!("knowledgeType" in obj)) {
      obj.knowledgeType = null
    }
  }

  // Message classification often omits reasoning when isGem is false; default to null
  if ("isGem" in obj && !("reasoning" in obj)) {
    obj.reasoning = null
  }

  // Default confidence if missing
  if (!("confidence" in obj)) {
    obj.confidence = 0.5
  }

  // For conversation classification: add defaults for boolean fields
  if ("isKnowledgeWorthy" in obj) {
    if (!("shouldReviseExisting" in obj)) {
      obj.shouldReviseExisting = false
    }
    if (!("revisionReason" in obj)) {
      obj.revisionReason = null
    }
    if (obj.isKnowledgeWorthy === false && !("knowledgeType" in obj)) {
      obj.knowledgeType = null
    }
  }

  return obj
}

export const memoRepair = createJsonRepair({
  fieldMappings: MEMO_SEMANTIC_FIELD_MAPPINGS,
  addDefaults: addMemoDefaults,
})
