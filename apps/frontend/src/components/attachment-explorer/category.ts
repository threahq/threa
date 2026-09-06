import { Archive, Code, File, FileSpreadsheet, FileText, Headphones, Image, Presentation, Video } from "lucide-react"
import type { ComponentType } from "react"
import { ATTACHMENT_CATEGORIES, type AttachmentCategory } from "@threahq/types"

export interface CategoryMeta {
  /** UI label shown in chip rail / picker. */
  label: string
  icon: ComponentType<{ className?: string }>
  /** Tailwind classes for the row thumbnail tint when no image preview exists. */
  accent: string
}

export const CATEGORY_META: Record<AttachmentCategory, CategoryMeta> = {
  image: { label: "Images", icon: Image, accent: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  video: { label: "Videos", icon: Video, accent: "bg-rose-500/15 text-rose-600 dark:text-rose-400" },
  audio: { label: "Audio", icon: Headphones, accent: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400" },
  pdf: { label: "PDFs", icon: FileText, accent: "bg-red-500/15 text-red-600 dark:text-red-400" },
  doc: { label: "Documents", icon: FileText, accent: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  sheet: { label: "Sheets", icon: FileSpreadsheet, accent: "bg-green-500/15 text-green-600 dark:text-green-400" },
  slide: { label: "Slides", icon: Presentation, accent: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  code: { label: "Code", icon: Code, accent: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  archive: { label: "Archives", icon: Archive, accent: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  other: { label: "Other", icon: File, accent: "bg-muted text-muted-foreground" },
}

export const CATEGORY_OPTIONS: Array<{ value: AttachmentCategory; label: string }> = ATTACHMENT_CATEGORIES.map(
  (value) => ({ value, label: CATEGORY_META[value].label })
)
