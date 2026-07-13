import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BoardReplyComposer } from "./board-reply-composer"
import { spyOnExport } from "@/test"
import * as inlineComposerModule from "@/components/board/board-inline-composer"
import * as useMobileModule from "@/hooks/use-mobile"
import * as hooksModule from "@/hooks"
import * as conversationsModule from "@/hooks/use-conversations"
import type { ComponentProps } from "react"
import type { BoardPost } from "@threa/types"

type InlineComposerFormProps = ComponentProps<typeof inlineComposerModule.InlineComposerForm>

const post = {
  conversation: { id: "conv_1", streamId: "stream_1", messageIds: ["msg_1"], topicSummary: "GPU budget" },
  openingMessage: { id: "msg_1" },
} as unknown as BoardPost

// Marker stub: the form's mount + the props under test, without the editor.
const FormStub = (props: InlineComposerFormProps) => (
  <div
    data-testid="form-stub"
    data-auto-focus={String(props.autoFocus ?? true)}
    data-restore={props.restoreStashedIdOnMount ?? ""}
  />
)

let formSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  formSpy = vi.fn(FormStub)
  spyOnExport(inlineComposerModule, "InlineComposerForm").mockReturnValue(formSpy as never)
  vi.spyOn(conversationsModule, "useReplyToBoardPost").mockReturnValue({
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof conversationsModule.useReplyToBoardPost>)
  spyOnExport(hooksModule, "useScopeDraftPreview").mockReturnValue((() => null) as never)
})

function mount(props: Partial<Parameters<typeof BoardReplyComposer>[0]> = {}) {
  return render(
    <BoardReplyComposer workspaceId="ws_1" post={post} hostStreamType="channel" lastActiveStreamId={null} {...props} />
  )
}

describe("BoardReplyComposer desktopAlwaysOpen (thread-composer semantics)", () => {
  it("desktop: mounts the form permanently — no resting button, no focus steal", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    mount({ desktopAlwaysOpen: true })
    const form = screen.getByTestId("form-stub")
    expect(form).toHaveAttribute("data-auto-focus", "false")
    expect(screen.queryByRole("button", { name: "Write a reply…" })).toBeNull()
  })

  it("mobile: keeps the collapsed⇄focused pair (resting button first)", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    mount({ desktopAlwaysOpen: true })
    expect(screen.queryByTestId("form-stub")).toBeNull()
    expect(screen.getByRole("button", { name: "Write a reply…" })).toBeTruthy()
  })

  it("board-card default: collapsed, and opening carries the advertised stash row for check-out", async () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    spyOnExport(hooksModule, "useScopeDraftPreview").mockReturnValue((() => ({
      draftId: "draft_adv",
      preview: "roamed body",
      attachmentCount: 0,
      isCheckedOut: false,
    })) as never)
    mount()
    const resting = screen.getByRole("button", { name: /roamed body/ })
    await userEvent.click(resting)
    expect(screen.getByTestId("form-stub")).toHaveAttribute("data-restore", "draft_adv")
  })
})
