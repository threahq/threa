import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, Visibilities, type Stream } from "@threahq/types"
import { spyOnExport } from "@/test/spy"
import { ServicesProvider, type StreamService } from "@/contexts"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as emojiModule from "@/hooks/use-workspace-emoji"
import * as giphyModule from "@/hooks/use-giphy-enabled"
import * as streamCommandsModule from "@/hooks/use-stream-commands"
import * as contextsModule from "@/contexts"
import * as currentUserModule from "@/hooks/use-current-workspace-user-id"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DescriptionSection } from "./description-section"

const NO_EMOJI = { emojis: [], emojiWeights: {}, toEmoji: () => null, toShortcode: () => null }

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  spyOnExport(mentionablesModule, "useMentionables").mockReturnValue((() => ({
    mentionables: [],
    isLoading: false,
  })) as never)
  spyOnExport(emojiModule, "useWorkspaceEmoji").mockReturnValue((() => NO_EMOJI) as never)
  spyOnExport(giphyModule, "useGiphyEnabled").mockReturnValue((() => false) as never)
  spyOnExport(streamCommandsModule, "useStreamCommands").mockReturnValue((() => []) as never)
  spyOnExport(contextsModule, "usePreferences").mockReturnValue((() => ({ preferences: {} })) as never)
  spyOnExport(currentUserModule, "useCurrentWorkspaceUserId").mockReturnValue((() => null) as never)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const stream = {
  id: "stream_chan",
  workspaceId: "ws_1",
  type: StreamTypes.CHANNEL,
  slug: "general",
  description: "Existing",
  visibility: Visibilities.PUBLIC,
} as Stream

describe("DescriptionSection unlock", () => {
  it("should make the editor editable without stealing focus when the section unlocks", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const tree = (locked: boolean) => (
      <QueryClientProvider client={queryClient}>
        <ServicesProvider services={{ streams: { update: vi.fn() } as unknown as StreamService }}>
          <MemoryRouter>
            <TooltipProvider>
              <button type="button">elsewhere</button>
              <DescriptionSection workspaceId="ws_1" stream={stream} locked={locked} />
            </TooltipProvider>
          </MemoryRouter>
        </ServicesProvider>
      </QueryClientProvider>
    )
    const { rerender } = render(tree(true))
    const elsewhere = screen.getByRole("button", { name: "elsewhere" })
    elsewhere.focus()

    rerender(tree(false))
    act(() => vi.runAllTimers())

    expect({
      editable: screen.getByRole("textbox", { name: "Stream description editor" }).getAttribute("contenteditable"),
      focusStayed: document.activeElement === elsewhere,
    }).toEqual({ editable: "true", focusStayed: true })
  })
})
