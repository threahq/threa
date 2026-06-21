import { Skeleton } from "@/components/ui/skeleton"

export function ActivitySkeleton() {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 sm:px-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 py-2.5 sm:py-3">
          <Skeleton className="h-8 w-8 rounded-[8px] shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-8 shrink-0" />
            </div>
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  )
}
