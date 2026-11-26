import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

interface DownloadVariantsMenuProps {
  /** The download button; it opens the menu instead of downloading. */
  children: React.ReactNode
  onProcessed(): void
  onOriginal(): void
}

/** The download choice for media the backend re-encodes: the processed file or the upload as it was sent. */
export function DownloadVariantsMenu({ children, onProcessed, onOriginal }: DownloadVariantsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        <DropdownMenuItem onClick={onProcessed}>Download processed</DropdownMenuItem>
        <DropdownMenuItem onClick={onOriginal}>Download original</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
