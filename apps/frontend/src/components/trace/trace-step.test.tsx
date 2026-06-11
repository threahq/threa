import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import {
  AgentReconsiderationDecisions,
  PI_TOOL_TRACE_FORMAT,
  PiToolTraceSectionLabels,
  type AgentSessionStep,
} from "@threa/types"
import { TraceStep } from "./trace-step"
import * as relativeTimeModule from "@/components/relative-time"
import * as e2eSessionModule from "@/stores/e2e-session-store"
import * as decryptCacheModule from "@/lib/crypto/decrypt-cache"

function createStep(overrides: Partial<AgentSessionStep> = {}): AgentSessionStep {
  return {
    id: "step_1",
    sessionId: "session_1",
    stepNumber: 1,
    stepType: "reconsidering",
    content: JSON.stringify({
      decision: AgentReconsiderationDecisions.KEPT_PREVIOUS_RESPONSE,
      reason: "The message edit only fixed grammar and didn't change the underlying request.",
    }),
    startedAt: "2026-02-19T18:00:00.000Z",
    completedAt: "2026-02-19T18:00:01.000Z",
    ...overrides,
  }
}

describe("TraceStep", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation((() => (
      <span>just now</span>
    )) as unknown as typeof relativeTimeModule.RelativeTime)
  })

  it("shows explicit keep-response reasoning for supersede no-change decisions", () => {
    render(
      <MemoryRouter>
        <TraceStep step={createStep()} workspaceId="ws_1" streamId="stream_1" />
      </MemoryRouter>
    )

    expect(
      screen.getByText("Kept the previous response unchanged after reconsidering the updated context.")
    ).toBeInTheDocument()
    expect(screen.getByText(/didn't change the underlying request/i)).toBeInTheDocument()
  })

  it("indicates edited messages in reconsideration context", () => {
    render(
      <MemoryRouter>
        <TraceStep
          step={createStep({
            content: JSON.stringify({
              draftResponse: "Original draft",
              newMessages: [
                {
                  messageId: "msg_edited",
                  changeType: "message_edited",
                  authorName: "Kris",
                  authorType: "user",
                  createdAt: "2026-02-19T18:00:00.000Z",
                  content: "Updated message content",
                },
              ],
            }),
          })}
          workspaceId="ws_1"
          streamId="stream_1"
        />
      </MemoryRouter>
    )

    expect(screen.getByText("Message changes arrived:")).toBeInTheDocument()
    expect(screen.getByText("Edited")).toBeInTheDocument()
  })

  it("surfaces the attached context-bag pill and referenced messages on the initial context step", async () => {
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <TraceStep
          step={createStep({
            stepType: "context_received",
            content: JSON.stringify({
              messages: [
                {
                  messageId: "msg_trigger",
                  authorName: "Kris",
                  authorType: "user",
                  createdAt: "2026-02-19T18:00:00.000Z",
                  content: "Whats up with this",
                  isTrigger: true,
                },
              ],
              attachedContext: {
                refs: [
                  {
                    streamId: "stream_dm_1",
                    fromMessageId: null,
                    toMessageId: null,
                    originMessageId: "msg_focal",
                    source: {
                      displayName: "Pierre",
                      slug: null,
                      type: "dm",
                      itemCount: 50,
                    },
                    messages: [
                      {
                        messageId: "msg_dm_1",
                        authorName: "Pierre",
                        createdAt: "2026-02-19T17:30:00.000Z",
                        // Markdown syntax that must NOT leak as literal characters
                        // into the trace preview surface (INV-60).
                        content: "**AI** for Prometheus rules looks great",
                      },
                      {
                        messageId: "msg_dm_2",
                        authorName: "Kris",
                        createdAt: "2026-02-19T17:31:00.000Z",
                        content: "Yeah PromQL queries too",
                      },
                    ],
                  },
                ],
              },
            }),
          })}
          workspaceId="ws_1"
          streamId="stream_1"
        />
      </MemoryRouter>
    )

    expect(screen.getByText("Attached context:")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /50 messages in Pierre/i })).toHaveAttribute(
      "href",
      "/w/ws_1/s/stream_dm_1?m=msg_focal"
    )

    // Messages are tucked behind a disclosure so the step stays compact;
    // expanding it reveals the actual content fed to the model.
    expect(screen.queryByText(/AI for Prometheus rules looks great/)).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Show 2 messages fed to the model/i }))
    expect(screen.getByText(/AI for Prometheus rules looks great/)).toBeInTheDocument()
    expect(screen.getByText(/PromQL queries too/)).toBeInTheDocument()
    // INV-60: markdown literals must not leak through the preview.
    expect(screen.queryByText(/\*\*AI\*\*/)).not.toBeInTheDocument()
  })

  it("shows rerun edit context in the initial context step", () => {
    render(
      <MemoryRouter>
        <TraceStep
          step={createStep({
            stepType: "context_received",
            content: JSON.stringify({
              rerunContext: {
                cause: "referenced_message_edited",
                editedMessageId: "msg_follow_up",
                editedMessageBefore: "Include peanuts please",
                editedMessageAfter: "No peanuts please",
              },
              messages: [],
            }),
          })}
          workspaceId="ws_1"
          streamId="stream_1"
        />
      </MemoryRouter>
    )

    expect(screen.getByText("Rerun caused by follow-up message edit")).toBeInTheDocument()
    expect(screen.getByText(/Include peanuts please/)).toBeInTheDocument()
    expect(screen.getByText(/No peanuts please/)).toBeInTheDocument()
  })

  it("renders edited output steps separately from sent output steps", () => {
    render(
      <MemoryRouter>
        <TraceStep
          step={createStep({
            stepType: "message_edited",
            content: "Updated response body",
            messageId: "msg_1",
          })}
          workspaceId="ws_1"
          streamId="stream_1"
        />
      </MemoryRouter>
    )

    expect(screen.getByText("Updated previous message:")).toBeInTheDocument()
    expect(screen.getByText(/Updated response body/)).toBeInTheDocument()
  })

  it("links workspace memo sources to the memory explorer", async () => {
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <TraceStep
          step={createStep({
            stepType: "workspace_search",
            content: JSON.stringify({
              memoCount: 1,
              messageCount: 0,
            }),
            sources: [
              {
                type: "workspace_memo",
                title: "Launch decision memo",
                memoId: "memo_1",
                streamId: "stream_2",
                streamName: "#launch",
              },
            ],
          })}
          workspaceId="ws_1"
          streamId="stream_1"
        />
      </MemoryRouter>
    )

    await user.click(screen.getByRole("button", { name: /sources/i }))

    expect(screen.getByRole("link", { name: "Launch decision memo" })).toHaveAttribute(
      "href",
      "/w/ws_1/memory?memo=memo_1"
    )
  })

  it("reveals the full research brief from a collapsed disclosure", async () => {
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <TraceStep
          step={createStep({
            stepType: "research",
            content: JSON.stringify({
              status: "ok",
              sourceCount: 3,
              briefAdded: true,
              brief: "## Recent AI news\n\nModel **X** shipped on Tuesday.",
            }),
          })}
          workspaceId="ws_1"
          streamId="stream_1"
        />
      </MemoryRouter>
    )

    expect(screen.getByText(/Synthesised a brief from 3 sources/i)).toBeInTheDocument()
    await user.click(screen.getByText(/Read the full brief/i))
    expect(screen.getByText("Recent AI news")).toBeInTheDocument()
    expect(screen.getByText(/shipped on Tuesday/i)).toBeInTheDocument()
  })

  it("renders a research step without a brief and shows no disclosure", () => {
    render(
      <MemoryRouter>
        <TraceStep
          step={createStep({
            stepType: "research",
            content: JSON.stringify({ status: "ok", sourceCount: 2, briefAdded: false }),
          })}
          workspaceId="ws_1"
          streamId="stream_1"
        />
      </MemoryRouter>
    )

    expect(screen.getByText(/Returned findings from 2 sources/i)).toBeInTheDocument()
    expect(screen.queryByText(/Read the full brief/i)).not.toBeInTheDocument()
  })

  it("renders tool_call args as a pretty-printed code block to prevent overflow", () => {
    // Regression for the case where wide JSON args (e.g. GitHub tool calls
    // with long repo paths) were rendered as a single inline span, which
    // forced the trace dialog to scroll horizontally. The fix renders args
    // in a <pre> with overflow-x-auto so the scroll is contained.
    render(
      <MemoryRouter>
        <TraceStep
          step={createStep({
            stepType: "tool_call",
            content: JSON.stringify({
              tool: "github_list_pull_requests",
              args: { repo: "threahq/threa", path: null, author: null, page: 1 },
            }),
          })}
          workspaceId="ws_1"
          streamId="stream_1"
        />
      </MemoryRouter>
    )

    const code = screen.getByText(/"repo": "threahq\/threa"/)
    const pre = code.closest("pre")
    expect(pre).not.toBeNull()
    expect(pre?.className).toMatch(/overflow-x-auto/)
    // Pretty-printed (multiline) rather than a single long line.
    expect(code.textContent).toContain("\n")
  })

  it("renders structured Pi tool_call content without markdown parsing", async () => {
    const user = userEvent.setup()
    const content = JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline: "Running git diff --stat",
      sections: [
        { label: PiToolTraceSectionLabels.ARGUMENTS, body: '{\n  "command": "git diff --stat"\n}', lang: "json" },
        { label: PiToolTraceSectionLabels.OUTPUT, body: "apps/backend/src/foo.ts | 11 +-", lang: null },
      ],
    })

    render(
      <MemoryRouter>
        <TraceStep step={createStep({ stepType: "tool_call", content })} workspaceId="ws_1" streamId="stream_1" />
      </MemoryRouter>
    )

    expect(screen.getByText("Running git diff --stat")).toBeInTheDocument()
    expect(screen.queryByText(/apps\/backend\/src\/foo\.ts/)).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Output/i }))
    expect(screen.getByText(/apps\/backend\/src\/foo\.ts/)).toBeInTheDocument()
  })

  it("renders truncated structured Pi tool traces as a collapsed fallback", async () => {
    const user = userEvent.setup()
    const content = `{"format":"${PI_TOOL_TRACE_FORMAT}","headline":"Running git diff","sections":[{"label":"Output","body":"apps/frontend/src/foo.ts\\n…[trace content truncated; 51 more characters]`

    render(
      <MemoryRouter>
        <TraceStep step={createStep({ stepType: "tool_call", content })} workspaceId="ws_1" streamId="stream_1" />
      </MemoryRouter>
    )

    expect(screen.getByText("Tool trace was truncated")).toBeInTheDocument()
    expect(screen.queryByText(/apps\/frontend\/src\/foo\.ts/)).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Details/i }))
    expect(screen.getByText(/apps\/frontend\/src\/foo\.ts/)).toBeInTheDocument()
  })

  it("renders tool_error with the Error output section open by default", () => {
    // For tool_error steps the reader almost always wants to see the failure
    // message immediately — keeping it collapsed buries the most relevant
    // detail. Arguments stay collapsed so the failure isn't crowded out.
    const content = JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline: "Running git commit -F .tmp/commit-msg.txt",
      sections: [
        {
          label: PiToolTraceSectionLabels.ARGUMENTS,
          body: '{ "command": "git commit -F .tmp/commit-msg.txt" }',
          lang: "json",
        },
        {
          label: PiToolTraceSectionLabels.ERROR_OUTPUT,
          body: "fatal: pathspec 'apps/frontend/src/api/bot-runtime.ts' did not match any files\nCommand exited with code 128",
          lang: null,
        },
      ],
    })

    render(
      <MemoryRouter>
        <TraceStep step={createStep({ stepType: "tool_error", content })} workspaceId="ws_1" streamId="stream_1" />
      </MemoryRouter>
    )

    expect(screen.getByText("Running git commit -F .tmp/commit-msg.txt")).toBeInTheDocument()
    // Error body is visible immediately.
    expect(screen.getByText(/did not match any files/)).toBeInTheDocument()
    // Arguments body stays collapsed.
    expect(screen.queryByText(/git commit -F \.tmp\/commit-msg\.txt"/)).not.toBeInTheDocument()
  })

  it("renders workspace_search content that arrives as a raw object without crashing", () => {
    // Regression for the crash where a step row's content was persisted as a
    // JSONB object (bypassing the pre-stringify convention), node-postgres
    // auto-parsed it back to a JS object, and React threw "Objects are not
    // valid as a React child" when the fallback span tried to render it.
    //
    // The wire type says `content?: string` so TypeScript can't warn us, but
    // the runtime value can be either. The defensive path in
    // `parseStructuredContent` + `coerceContentToString` should handle both.
    render(
      <MemoryRouter>
        <TraceStep
          step={createStep({
            stepType: "workspace_search",
            // Raw object content — matches the buggy state produced by an
            // intermediate persistence code-path that forgot to pre-stringify.
            content: { substeps: [{ text: "Planning queries…", at: "2026-04-10T12:00:00Z" }] } as unknown as string,
            completedAt: undefined, // in-progress
          })}
          workspaceId="ws_1"
          streamId="stream_1"
        />
      </MemoryRouter>
    )

    // No throw means the defensive path worked. As a bonus, confirm the
    // substep text is visible — parseStructuredContent should have treated
    // the object as already-parsed and pulled out the substeps.
    expect(screen.getByText("Planning queries…")).toBeInTheDocument()
  })

  it("renders the sources sealed inside a decrypted step payload (E2EE-14)", async () => {
    const user = userEvent.setup()
    vi.spyOn(e2eSessionModule, "useE2eSession").mockReturnValue({
      status: "unlocked",
      privateKey: {} as CryptoKey,
      keyId: "key_1",
    } as unknown as ReturnType<typeof e2eSessionModule.useE2eSession>)
    vi.spyOn(decryptCacheModule, "getCachedDecryption").mockReturnValue({
      status: "decrypted",
      content: {
        contentMarkdown: "tides",
        contentJson: { type: "doc" } as never,
        sources: [{ type: "web", title: "Tide Atlas", url: "https://tides.example/atlas" }],
      },
    })

    render(
      <MemoryRouter>
        <TraceStep
          step={createStep({
            stepType: "web_search",
            content: undefined,
            contentCiphertext: "abc",
            contentEnvelope: { v: 2, keyGeneration: 0, iv: "x", aad: "y" },
          })}
          workspaceId="ws_1"
          streamId="stream_1"
          userId="member_1"
        />
      </MemoryRouter>
    )

    // The sealed step has no cleartext `sources` column — the list renders
    // from the decrypted payload, exactly like a plaintext step's column does.
    await user.click(screen.getByRole("button", { name: /sources/i }))
    expect(screen.getByRole("link", { name: "Tide Atlas" })).toHaveAttribute("href", "https://tides.example/atlas")
    expect(screen.getByText("tides.example")).toBeInTheDocument()
  })

  it("renders no sources for a sealed step while the scratchpad is locked", () => {
    vi.spyOn(e2eSessionModule, "useE2eSession").mockReturnValue({
      status: "locked",
    } as unknown as ReturnType<typeof e2eSessionModule.useE2eSession>)

    render(
      <MemoryRouter>
        <TraceStep
          step={createStep({
            stepType: "web_search",
            content: undefined,
            contentCiphertext: "abc",
            contentEnvelope: { v: 2 },
          })}
          workspaceId="ws_1"
          streamId="stream_1"
          userId="member_1"
        />
      </MemoryRouter>
    )

    expect(screen.getByText("Unlock this scratchpad to view this step")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /sources/i })).not.toBeInTheDocument()
  })
})
