import { z } from "zod"
import { EXTRACTION_CONTENT_TYPES } from "@threahq/types"

export const IMAGE_CAPTION_MODEL_ID = "openrouter:google/gemini-2.5-flash"

export const IMAGE_CAPTION_TEMPERATURE = 0.1

/**
 * Output cap. A verbatim transcription of a dense screenshot plus its
 * structured data runs long; without an explicit cap the provider default
 * truncates mid-JSON and the result only ever surfaces as a repair failure.
 */
export const IMAGE_CAPTION_MAX_TOKENS = 8_000

/** Used to recognise images when mime_type is application/octet-stream. */
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif"] as const

/** ISO-BMFF brands in the `ftyp` box that mean the file is a HEIF/HEIC still. */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"])

/**
 * Media type read off the bytes themselves. Uploads that arrive as
 * "application/octet-stream" carry no usable type, and labelling a JPEG as PNG
 * in the request makes providers reject it, so the signature is the only
 * trustworthy source. Null when the bytes match none of the supported formats.
 */
export function detectImageMediaType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null

  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png"
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg"
  if (buffer.subarray(0, 3).toString("latin1") === "GIF") return "image/gif"
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp"
  }
  if (buffer.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("latin1")
    if (HEIF_BRANDS.has(brand)) return "image/heic"
  }

  return null
}

/**
 * Treats "application/octet-stream" as an image when the extension matches, since
 * some clients upload images with a generic MIME type.
 */
export function isImageAttachment(mimeType: string, filename: string): boolean {
  if (mimeType.startsWith("image/")) {
    return true
  }

  if (mimeType === "application/octet-stream") {
    const lowerFilename = filename.toLowerCase()
    return IMAGE_EXTENSIONS.some((ext) => lowerFilename.endsWith(ext))
  }

  return false
}

export const chartDataSchema = z.object({
  chartType: z.string().describe("Type of chart (bar, line, pie, scatter, etc.)"),
  title: z.string().nullable().describe("Chart title if visible"),
  axes: z
    .object({
      x: z.string().nullable().describe("X-axis label"),
      y: z.string().nullable().describe("Y-axis label"),
    })
    .nullable()
    .describe("Axis labels if visible"),
  dataPoints: z
    .array(
      z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
      })
    )
    .nullable()
    .describe("Key data points extracted from the chart"),
  trends: z.array(z.string()).nullable().describe("Notable trends or patterns observed"),
})

export const tableDataSchema = z.object({
  headers: z.array(z.string()).describe("Column headers"),
  rows: z.array(z.array(z.string())).describe("Table rows as arrays of cell values"),
  summary: z.string().nullable().describe("Brief summary of what the table shows"),
})

export const diagramDataSchema = z.object({
  diagramType: z.string().describe("Type of diagram (flowchart, sequence, entity-relationship, etc.)"),
  nodes: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
      })
    )
    .nullable()
    .describe("Key nodes/elements in the diagram"),
  connections: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        label: z.string().nullable(),
      })
    )
    .nullable()
    .describe("Connections between nodes"),
  description: z.string().nullable().describe("What the diagram illustrates"),
})

export const imageAnalysisSchema = z.object({
  contentType: z.enum(EXTRACTION_CONTENT_TYPES).describe("Primary content type of the image"),
  summary: z
    .string()
    .describe(
      "Self-contained account of the image, normally 3-6 sentences, naming the specifics (application, screen, identifiers, values, units, errors, state). A reader who never sees the image relies on this alone."
    ),
  extractedText: z
    .object({
      headings: z.array(z.string()).nullable().describe("Titles, headers, tab and window names, verbatim"),
      labels: z
        .array(z.string())
        .nullable()
        .describe("Axis labels, legends, buttons, menu items, field names, captions, badges, status text"),
      body: z
        .string()
        .nullable()
        .describe("Every remaining legible line, verbatim and in reading order, line breaks preserved"),
    })
    .nullable()
    .describe("Text transcribed from the image, in its original language"),
  structuredData: z
    .union([chartDataSchema, tableDataSchema, diagramDataSchema])
    .nullable()
    .describe(
      "Underlying data of any chart, table or diagram in the image, whatever the contentType. Null when the image holds none."
    ),
})

export type ImageAnalysisOutput = z.infer<typeof imageAnalysisSchema>

export const IMAGE_CAPTION_SYSTEM_PROMPT = `You extract images into text for a team knowledge product. What you write is usually the ONLY representation of this image anyone or anything downstream ever gets. Assistants answering questions about the conversation, search, and knowledge extraction all read your text, not the picture. Whatever you leave out is lost, and recovering it costs another look at the image.

Produce:

1. contentType, one of:
   - "chart": graphs, plots, visualisations
   - "table": tabular data
   - "diagram": flowcharts, architecture, sequence, entity-relationship
   - "screenshot": application UI, terminals, code editors, dashboards, web pages
   - "photo": real-world scenes, objects, people, whiteboards
   - "document": scans, pages of prose, forms, invoices, slides
   - "other": none of the above

2. summary: a self-contained account of the image, normally 3-6 sentences. Someone who reads only this, and never sees the picture, should be able to answer questions about it and judge whether opening it is worth it.
   Name the specifics: which application or site, which screen or document, the identifiers, versions, dates, counts, amounts and their units, the exact error text, what is selected or highlighted or failing, the direction and rough magnitude of anything plotted. Quote short strings that carry the meaning exactly as written.
   Start with the subject, not with "This image shows" or "The screenshot depicts". State what is there; do not speculate about why it was shared or what it is used for.

3. extractedText: transcribe the text that is genuinely legible, in reading order:
   - headings: titles, headers, tab and window names
   - labels: axis labels, legends, buttons, menu items, field names, captions, annotations, badge and status text
   - body: every remaining line, verbatim, preserving line breaks and reading order. Finish a column before moving to the next one in multi-column layouts. Keep code, commands, log lines, stack traces, URLs, file paths, identifiers and numbers character-accurate; those are what people look up later.
   Transcribe in the language on the page; never translate. Leave a field null when there is genuinely nothing to put in it, and never invent text you cannot read.

4. structuredData: whenever the image contains a chart, a table or a diagram, capture its underlying data so it can be reasoned over without the picture: chart type, title, axes, every data point you can read (not a sample), and the trends; table headers and every row; diagram type, nodes, connections and what it illustrates. This applies wherever the data sits, not only when it is the whole image: line items on an invoice, a results grid in a screenshot, a plot inside a slide. Null when the image holds no such data.

Read the whole frame before writing: small print, sidebars, status bars, toasts, and anything partly cut off. Report what is there, not what you expect to be there.

Output ONLY valid JSON matching the schema.`

export const IMAGE_CAPTION_USER_PROMPT = `Extract this image.`
