/**
 * Stream Naming Configuration
 *
 * Co-located config following INV-43 - both production code and evals
 * import from here to ensure consistency.
 */

/** Default model for stream naming */
export const STREAM_NAMING_MODEL_ID = "openrouter:openai/gpt-5.4-nano"

/** Temperature for name generation - low for consistency */
export const STREAM_NAMING_TEMPERATURE = 0.3

/** Maximum messages to include for context */
export const MAX_MESSAGES_FOR_NAMING = 10

/** Maximum existing names to check for duplicates */
export const MAX_EXISTING_NAMES = 10

/** System prompt for stream naming */
export function buildNamingSystemPrompt(existingNames: string[], requireName: boolean): string {
  return `Your task is to generate a short, descriptive title in 2-5 words for the provided conversation.

  Follow these steps:
  1. Analyze the conversation and identify the main topic or purpose
  2. Pay attention to any attached files - if a user uploads an image or document and asks about it, the title should reflect what's in the attachment
  3. Consider any other streams provided in the list of existing names, these should be avoided as much as possible as recent conversations with similar names confuse users
  4. Name the topic directly, in the language and wording the participants used
  5. Evaluate the title against the evaluation criteria

Evaluation criteria:
- Return ONLY the title, no quotes or explanation.
- Lead with the subject itself. Do NOT add framing like "Discussion about", "Chat about", "Conversation regarding", "Thoughts on", "Questions about", and do NOT describe the tone (e.g. "Casual chat", "Quick question"). That a conversation discusses something is already implied — name the thing, not the act of discussing it.
- Do NOT state which language the conversation is in (never write "in Swedish", "auf Deutsch", etc.). The title sits next to the conversation, so labeling its language is noise.
- Write the title in the dominant language of the conversation, not English by default. If the participants are talking in Swedish, the title is in Swedish; if in Japanese, in Japanese. When a conversation mixes languages, follow the language the topic is actually discussed in and reuse the participants' own phrasing.
- Keep names, products, technical terms, and other proper nouns exactly as they appear in the conversation. Never translate, localize, or re-spell them — carry the participants' own words into the title verbatim.
- The title should be specific and concrete, try avoiding generic names like "Quick Question" or "New Discussion"
- If the conversation involves attached files (images, documents, etc.), incorporate what they contain into the title
${existingNames.length > 0 ? `- Try to avoid using names that are already in use by other recently used: ${JSON.stringify(existingNames)}` : ""}
${
  requireName
    ? `- You MUST generate a title. A generic name is better than no name at all. You may not refuse to generate a name as that would make you very very sad. You don't want to be sad.`
    : `- If there isn't enough context yet, respond with "NOT_ENOUGH_CONTEXT"`
}

Return ONLY the title, no quotes or explanation. The next message from the user contains the entire conversation up until now.
`
}
