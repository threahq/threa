import { createJsonRepair } from "@threa/agent-runtime"

/**
 * JSON repair for the extractor output. The model occasionally omits the
 * outer `items` array when it found nothing — normalize that to an empty list
 * so an "extracted no to-dos" run parses cleanly instead of failing schema
 * validation and retrying.
 */
function addSuggestionDefaults(obj: Record<string, unknown>): Record<string, unknown> {
  if (!("items" in obj) || obj.items == null) {
    obj.items = []
  }
  return obj
}

export const suggestionRepair = createJsonRepair({
  addDefaults: addSuggestionDefaults,
})
