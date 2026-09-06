import { z } from "zod"
import { EXTRACTION_CONTENT_TYPES } from "@threahq/types"

export const IMAGE_CAPTION_MODEL_ID = "openrouter:google/gemini-2.5-flash"

export const IMAGE_CAPTION_TEMPERATURE = 0.1

/** Used to recognise images when mime_type is application/octet-stream. */
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif"] as const

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
  summary: z.string().describe("1-2 sentence description of what the image shows"),
  extractedText: z
    .object({
      headings: z.array(z.string()).nullable().describe("Headings or titles visible in the image"),
      labels: z.array(z.string()).nullable().describe("Labels, captions, or annotations"),
      body: z.string().nullable().describe("Main text content if this is a document or screenshot"),
    })
    .nullable()
    .describe("Text extracted from the image"),
  structuredData: z
    .union([chartDataSchema, tableDataSchema, diagramDataSchema])
    .nullable()
    .describe("Type-specific structured data for charts, tables, or diagrams"),
})

export type ImageAnalysisOutput = z.infer<typeof imageAnalysisSchema>

export const IMAGE_CAPTION_SYSTEM_PROMPT = `You are an image analysis specialist for a team collaboration application. Your role is to extract structured information from images to help AI assistants understand visual content in conversations.

Analyze the image and extract:

1. **Content Type**: Classify as one of:
   - "chart" - graphs, plots, visualizations
   - "table" - tabular data
   - "diagram" - flowcharts, architecture diagrams, sequence diagrams
   - "screenshot" - UI screenshots, code screenshots
   - "photo" - photographs of real-world objects or scenes
   - "document" - scanned documents, PDFs, text-heavy images
   - "other" - anything that doesn't fit above

2. **Summary**: Write a 1-2 sentence description that would help someone understand the image without seeing it. Be factual and specific.

3. **Extracted Text**: If there's text in the image:
   - headings: Main titles or headers
   - labels: Axis labels, legends, captions, annotations
   - body: Main text content (for documents/screenshots)

4. **Structured Data**: For charts, tables, and diagrams, extract the underlying data:
   - Charts: type, title, axes, key data points, trends
   - Tables: headers, rows, summary
   - Diagrams: type, nodes, connections, description

Focus on information that would be useful for understanding the context of a conversation. Be thorough but concise.

Output ONLY valid JSON matching the schema.`

export const IMAGE_CAPTION_USER_PROMPT = `Analyze this image and extract structured information.`
