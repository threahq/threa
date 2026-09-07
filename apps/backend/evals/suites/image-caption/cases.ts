/**
 * Image Caption Test Cases
 *
 * Fixtures are committed PNGs rendered from the `.html` beside them
 * (`fixtures/render.ts`), so a run compares models rather than font stacks.
 */

import type { EvalCase } from "../../framework/types"
import { ExtractionContentTypes } from "@threahq/types"
import type { ImageCaptionInput, ImageCaptionExpected } from "./types"

export const imageCaptionCases: EvalCase<ImageCaptionInput, ImageCaptionExpected>[] = [
  {
    id: "caption-deploy-failure",
    name: "Deploy failure screenshot with a build log",
    input: {
      fixture: "deploy-failure.png",
      description: "Deployment UI for threa-backend, failed build, terminal log below",
    },
    expectedOutput: {
      contentType: ExtractionContentTypes.SCREENSHOT,
      requiredText: [
        "threa-backend",
        "dep_8f31c2a",
        "9a65ed9a7",
        "eu-west-1",
        "OOMKilled",
        "Build failed: exit code 137",
        "dep_71b09de",
        "bun install --frozen-lockfile",
        "Memory limit 512 MiB",
      ],
      summaryMentions: ["threa-backend", "137", "OOMKilled"],
      structuredData: "absent",
    },
  },
  {
    id: "caption-latency-chart",
    name: "Bar chart of p95 latency by region",
    input: {
      fixture: "latency-chart.png",
      description: "Horizontal bar chart, five regions, two over the 300 ms target",
    },
    expectedOutput: {
      contentType: ExtractionContentTypes.CHART,
      requiredText: [
        "API p95 latency by region",
        "eu-west-1",
        "ap-south-1",
        "182",
        "446",
        "p95 latency (ms)",
        "Within target",
        "Over target",
      ],
      summaryMentions: ["ap-south-1", "446", "300"],
      structuredData: "required",
    },
  },
  {
    id: "caption-pricing-table",
    name: "Table of model spend with a totals row",
    input: {
      fixture: "pricing-table.png",
      description: "Six-column spend table, five body rows and a total",
    },
    expectedOutput: {
      contentType: ExtractionContentTypes.TABLE,
      requiredText: [
        "Model spend, August 2026",
        "gemini-2.5-flash",
        "gpt-5.6-luna",
        "claude-sonnet-5",
        "memo-classifier",
        "128,940",
        "315.87",
      ],
      summaryMentions: ["315.87", "spend"],
      structuredData: "required",
    },
  },
  {
    id: "caption-ingest-diagram",
    name: "Flow diagram of the extraction pipeline",
    input: {
      fixture: "ingest-diagram.png",
      description: "Six-node flowchart with edge labels and a footnote",
    },
    expectedOutput: {
      contentType: ExtractionContentTypes.DIAGRAM,
      requiredText: [
        "Attachment extraction pipeline",
        "Detect type",
        "image-caption",
        "pdf / word / excel",
        "Extraction row",
        "Search index",
        "tsvector",
        "concurrency 4",
      ],
      summaryMentions: ["image-caption", "Search index"],
      structuredData: "required",
    },
  },
  {
    id: "caption-swedish-invoice",
    name: "Swedish invoice, transcribed without translation",
    input: {
      fixture: "swedish-invoice.png",
      description: "Invoice in Swedish with line items, VAT and payment terms",
    },
    expectedOutput: {
      contentType: ExtractionContentTypes.DOCUMENT,
      requiredText: [
        "Faktura 2026-4471",
        "Förfallodatum",
        "2026-09-30",
        "559312-4478",
        "Objektlagring",
        "Konsulttimmar",
        "43 400,00",
        "bankgiro 5312-4478",
      ],
      summaryMentions: ["43 400", "2026-4471"],
      structuredData: "required",
      // The transcription is meant to stay in the language on the page.
      forbiddenText: ["Invoice date", "Due date", "Amount due", "Consulting hours"],
    },
  },
]
