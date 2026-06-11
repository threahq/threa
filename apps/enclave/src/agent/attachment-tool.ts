import { z } from "zod"
import { AgentStepTypes } from "@threa/types"
import { base64ToBytes, bytesToBase64, decryptAttachmentBytes, type AttachmentRef } from "@threa/crypto"
import { defineAgentTool, type AgentTool, type AgentToolResult } from "@threa/agent-runtime/runtime"

/**
 * Everything the enclave holds about this turn's attachments: the refs
 * (per-file key/iv/filename/mime, decrypted out of each message's sealed
 * payload) and the opaque ciphertext the backend shipped inline (the enclave
 * can't reach S3 — egress is backend + OpenRouter only).
 */
export interface EnclaveAttachmentStore {
  refsById: Map<string, AttachmentRef>
  ciphertextById: Map<string, string>
}

const LoadAttachmentSchema = z.object({
  attachmentId: z.string().describe("The attachment id from an [Attached: …] note in the conversation"),
})

/**
 * The enclave's `load_attachment`: same tool name the main-app agent has, but
 * sourced entirely in-process — ref + ciphertext travel with the turn, and the
 * decrypt happens next to the model call, so plaintext never leaves the
 * enclave. History messages carry `[Attached: "name" (id)]` notes instead of
 * auto-fed bytes; the model calls this when it actually needs a file, which
 * keeps multi-turn token cost proportional to use.
 *
 * Deliberately NOT gated by the stream's tool-privacy policy: these files are
 * the conversation's own content (their refs already ride the messages the
 * model reads), not workspace reads or web egress.
 */
export function createEnclaveLoadAttachmentTool(store: EnclaveAttachmentStore): AgentTool {
  return defineAgentTool({
    name: "load_attachment",
    description: `Load a file attached to this conversation so you can read it. Use the attachment id from the [Attached: "filename" (attachment id)] note on the message that shared it.

Works for any attached file: images and PDFs are loaded for direct viewing; text files (markdown, code, CSV, logs) return their contents.`,
    // Empty = conversation-local (see the doc comment above): the per-stream
    // tool-privacy filter in buildEnclaveTools never drops this tool.
    categories: [],
    promptBlock: `## Loading Attachments

You have a \`load_attachment\` tool to load a file shared in this conversation for direct analysis.

When to use load_attachment:
- When the user asks you to look at or analyze an attached file
- When a message carries an \`[Attached: "filename" (attachment id)]\` note and you need the file's actual content

Images and PDFs are returned for direct viewing; text-readable files return their contents.`,
    inputSchema: LoadAttachmentSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const ref = store.refsById.get(input.attachmentId)
      const ciphertext = store.ciphertextById.get(input.attachmentId)
      if (!ref || !ciphertext) {
        return {
          output: JSON.stringify({
            error: "Attachment not available in this conversation (unknown id, or the file was too large to ship)",
            attachmentId: input.attachmentId,
          }),
        }
      }

      let bytes: Uint8Array
      try {
        bytes = await decryptAttachmentBytes({ ciphertext: base64ToBytes(ciphertext), key: ref.key, iv: ref.iv })
      } catch {
        return {
          output: JSON.stringify({ error: "Attachment could not be decrypted", attachmentId: input.attachmentId }),
        }
      }

      if (ref.mimeType.startsWith("image/")) {
        return {
          output: `Image loaded: ${ref.filename} (${ref.mimeType})`,
          multimodal: [{ type: "image", url: `data:${ref.mimeType};base64,${bytesToBase64(bytes)}` }],
        }
      }
      if (ref.mimeType === "application/pdf") {
        return {
          output: `File loaded: ${ref.filename} (${ref.mimeType})`,
          multimodal: [{ type: "file", data: bytesToBase64(bytes), mediaType: ref.mimeType, filename: ref.filename }],
        }
      }

      // Anything else: valid UTF-8 (markdown, code, CSV — browsers report no
      // MIME for most of these, so the ref often says octet-stream) returns its
      // contents; true binary is an honest error instead of a request the
      // provider would reject.
      const text = decodeUtf8(bytes)
      if (text !== null) {
        return { output: `Contents of "${ref.filename}":\n\n${text}` }
      }
      return {
        output: JSON.stringify({
          error: `Attachment is a binary format (${ref.mimeType}) that can't be read directly`,
          attachmentId: input.attachmentId,
        }),
      }
    },

    trace: {
      stepType: AgentStepTypes.TOOL_CALL,
      formatContent: (input, result) => {
        if (result.multimodal && result.multimodal.length > 0) {
          return `Loaded attachment: ${(input as { attachmentId: string }).attachmentId}`
        }
        return result.output
      },
    },
  })
}

/** Strict UTF-8 decode: returns null for bytes that aren't valid UTF-8 (binary). */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
