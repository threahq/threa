import { getAttachment, getAttachmentDownloadUrl } from "../ops"
import { boolFlag, UsageError, type CommandSpec } from "../output"

export const attachmentCommand: CommandSpec = {
  name: "attachment",
  summary: "Get an attachment's metadata and extracted text, or a signed download URL",
  usage: "threa attachment <id> [--url]",
  help:
    "threa attachment <id> [flags]\n\n" +
    "Retrieve an attachment's metadata and extracted text. With --url, instead return a short-lived signed URL " +
    "to download the raw bytes.\n\n" +
    "Flags:\n" +
    "  --url     return a short-lived signed download URL instead of the metadata/text\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {
    url: { type: "boolean" },
  },
  run: (ctx, positionals, values) => {
    const id = positionals[0]
    if (!id) throw new UsageError("attachment requires a <id> (an att_ id)")
    return boolFlag(values, "url") ? getAttachmentDownloadUrl(ctx.client, id) : getAttachment(ctx.client, id)
  },
}
