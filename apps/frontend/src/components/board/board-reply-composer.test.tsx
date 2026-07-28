import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen } from "@testing-library/react"
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
    data-docked={String(!!props.docked)}
    data-draft-key={props.draftKey}
    data-reply-target-title={props.replyTarget?.title ?? ""}
    data-reply-target-move={props.replyTarget?.moveDraftToKey ?? ""}
    data-schedule-conv={props.scheduleTarget?.conversationId ?? ""}
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

describe("BoardReplyComposer alwaysDocked (docked-composer semantics)", () => {
  it("desktop: mounts the form permanently, docked — no resting button, no focus steal", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    mount({ alwaysDocked: true })
    const form = screen.getByTestId("form-stub")
    expect(form).toHaveAttribute("data-auto-focus", "false")
    expect(form).toHaveAttribute("data-docked", "true")
    expect(screen.queryByRole("button", { name: "Write a reply…" })).toBeNull()
  })

  it("mobile: still mounts the docked form — no resting button (MessageComposer owns the collapsed bar)", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    mount({ alwaysDocked: true })
    const form = screen.getByTestId("form-stub")
    expect(form).toHaveAttribute("data-docked", "true")
    expect(screen.queryByRole("button", { name: "Write a reply…" })).toBeNull()
  })

  it("armed: retargets the docked form to the branch scope + schedule target with a dismissible strip", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    const onCancel = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    mount({
      alwaysDocked: true,
      armedReply: {
        draftKey: "board:branch-reply:conv_branch",
        title: "Sub-topic",
        scheduleTarget: { streamId: "stream_branch", conversationId: "conv_branch" },
        restoreStashedId: null,
        restoreSignal: 1,
        onSubmit,
        onCancel,
      },
    })
    const form = screen.getByTestId("form-stub")
    expect(form).toHaveAttribute("data-draft-key", "board:branch-reply:conv_branch")
    expect(form).toHaveAttribute("data-schedule-conv", "conv_branch")
    expect(form).toHaveAttribute("data-reply-target-title", "Sub-topic")
    // The × moves the branch draft back to the conversation's ROOT reply scope.
    expect(form).toHaveAttribute("data-reply-target-move", "board:reply:conv_1")
  })

  it("unarmed docked: targets the root reply scope, no strip", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    mount({ alwaysDocked: true })
    const form = screen.getByTestId("form-stub")
    expect(form).toHaveAttribute("data-draft-key", "board:reply:conv_1")
    expect(form).toHaveAttribute("data-schedule-conv", "conv_1")
    expect(form).toHaveAttribute("data-reply-target-title", "")
  })

  it("quiet close: focus still lands on the resting bar, but its ring is withheld until the next keystroke", async () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    mount()
    await userEvent.click(screen.getByRole("button", { name: "Write a reply…" }))

    const onClose = (formSpy.mock.calls.at(-1)![0] as InlineComposerFormProps).onClose
    act(() => onClose({ refocus: true, quiet: true }))

    const resting = screen.getByRole("button", { name: "Write a reply…" })
    // Focus is restored either way — dropping it strands a screen-reader user.
    expect(document.activeElement).toBe(resting)
    expect(resting.className).toContain("focus-visible:ring-0")

    // Any keystroke means the user is navigating: the ring comes back.
    await userEvent.keyboard("{Tab}")
    expect(screen.getByRole("button", { name: "Write a reply…" }).className).not.toContain("focus-visible:ring-0")
  })

  it("loud close: focus and the ring both land on the resting bar", async () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    mount()
    await userEvent.click(screen.getByRole("button", { name: "Write a reply…" }))

    const onClose = (formSpy.mock.calls.at(-1)![0] as InlineComposerFormProps).onClose
    act(() => onClose({ refocus: true, quiet: false }))

    const resting = screen.getByRole("button", { name: "Write a reply…" })
    expect(document.activeElement).toBe(resting)
    expect(resting.className).not.toContain("focus-visible:ring-0")
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
