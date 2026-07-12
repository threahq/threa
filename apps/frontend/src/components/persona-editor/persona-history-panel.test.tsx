import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { forwardRef, useImperativeHandle } from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { JSONContent, PersonaConfigResponse, PersonaConfigRevision, PersonaResolvedConfig } from "@threa/types"
import { personasApi } from "@/api"
import { ApiError } from "@/api/client"
import { spyOnExport } from "@/test/spy"
import * as editorModule from "@/components/editor"
import * as actorsModule from "@/hooks/use-actors"
import { personaKeys, usePersonaConfig } from "@/hooks/use-personas"
import { PersonaEditorForm } from "./persona-editor-form"

const WS = "ws_1"
const PERSONA = "persona_system_ariadne"

function extractText(node: JSONContent | undefined): string {
  if (!node) return ""
  if (node.type === "text") return node.text ?? ""
  return (node.content ?? []).map((child) => extractText(child)).join("")
}
function createDoc(text: string): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }] }
}

beforeEach(() => {
  const MockRichEditor = forwardRef<
    {
      focus: () => void
      insertMention: () => void
      insertSlash: () => void
      insertEmoji: () => void
      getEditor: () => null
    },
    { value: JSONContent; onChange: (v: JSONContent) => void; onSubmit?: () => void; ariaLabel?: string }
  >(function MockRichEditor({ value, onChange, ariaLabel }, ref) {
    useImperativeHandle(ref, () => ({
      focus: () => undefined,
      insertMention: () => undefined,
      insertSlash: () => undefined,
      insertEmoji: () => undefined,
      getEditor: () => null,
    }))
    return (
      <textarea
        aria-label={ariaLabel}
        value={extractText(value)}
        onChange={(e) => onChange(createDoc(e.target.value))}
      />
    )
  })
  spyOnExport(editorModule, "RichEditor").mockReturnValue(MockRichEditor as unknown as typeof editorModule.RichEditor)
  const MockEditorActionBar = (({ trailingContent }: Record<string, unknown>) => (
    <div>{trailingContent as React.ReactNode}</div>
  )) as unknown as typeof editorModule.EditorActionBar
  spyOnExport(editorModule, "EditorActionBar").mockReturnValue(MockEditorActionBar)

  // Resolve revision authors to a stable name so the row's "who" is asserted
  // without seeding the dexie-backed workspace store.
  const actorLookup = {
    getActorName: (id: string | null) => (id === "usr_alice" ? "Alice" : "Someone"),
    getActorInitials: () => "A",
    getActorAvatar: () => ({ fallback: "A" }),
    getUser: () => undefined,
    getPersona: () => undefined,
    getBot: () => undefined,
  } as unknown as ReturnType<typeof actorsModule.useActors>
  spyOnExport(actorsModule, "useActors").mockReturnValue((() => actorLookup) as typeof actorsModule.useActors)
})

afterEach(() => vi.restoreAllMocks())

function defaults(): PersonaResolvedConfig {
  return {
    id: PERSONA,
    workspaceId: null,
    slug: "ariadne",
    name: "Ariadne",
    description: "Your AI thinking companion.",
    avatarEmoji: ":thread:",
    systemPrompt: "You are Ariadne.",
    model: "openrouter:anthropic/claude-sonnet-4.6",
    escalationModel: "openrouter:anthropic/claude-opus-4.8",
    temperature: 0.7,
    maxTokens: null,
    enabledTools: ["send_message", "web_search"],
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: null,
    brevityPrompt: null,
    managedBy: "system",
    status: "active",
    visibility: "visible",
    e2eCapable: true,
  }
}

// A workspace already customized to v2 (name + model), so the panel's OCC token
// (overrideUpdatedAt) is non-null and a restore asserts against it.
function config(): PersonaConfigResponse {
  const d = defaults()
  const overridePatch = { name: "V2 name", model: "openrouter:anthropic/claude-opus-4.8" }
  return {
    kind: "builtin",
    defaults: d,
    overridePatch,
    overrideUpdatedAt: "2026-07-11T02:00:00Z",
    resolved: { ...d, ...overridePatch },
    draft: null,
    availableModels: [
      { id: "openrouter:anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
      { id: "openrouter:anthropic/claude-opus-4.8", label: "Claude Opus 4.8" },
    ],
  }
}

const revisions: PersonaConfigRevision[] = [
  {
    id: "acrev_2",
    version: 2,
    patch: { name: "V2 name", model: "openrouter:anthropic/claude-opus-4.8" },
    createdByKind: "user",
    createdById: "usr_alice",
    createdAt: "2026-07-11T02:00:00Z",
  },
  {
    id: "acrev_1",
    version: 1,
    patch: { name: "V1 name" },
    createdByKind: "user",
    createdById: "usr_bob",
    createdAt: "2026-07-10T00:00:00Z",
  },
]

function makeClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(personaKeys.config(WS, PERSONA), config())
  return queryClient
}

/** Drives the form off the config cache exactly like the page, so a restore's
 *  cache write re-seeds the form (the real reconcile path). */
function Harness() {
  const { data } = usePersonaConfig(WS, PERSONA)
  if (!data) return null
  return <PersonaEditorForm workspaceId={WS} personaId={PERSONA} config={data} />
}

function renderEditor(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>
  )
}

async function openHistory(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /History/ }))
  return screen.findByRole("dialog")
}

describe("PersonaHistoryPanel", () => {
  it("lists revisions newest-first with who, and marks the newest current", async () => {
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config())
    vi.spyOn(personasApi, "listRevisions").mockResolvedValue(revisions)
    const user = userEvent.setup()
    renderEditor(makeClient())

    const dialog = await openHistory(user)
    expect(await within(dialog).findByText("Version 2")).toBeInTheDocument()
    expect(within(dialog).getByText("Version 1")).toBeInTheDocument()
    expect(within(dialog).getByText("Current")).toBeInTheDocument()
    expect(within(dialog).getByText(/Alice/)).toBeInTheDocument()
  })

  it("summarizes each revision's changes against the previous (older) one", async () => {
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config())
    vi.spyOn(personasApi, "listRevisions").mockResolvedValue(revisions)
    const user = userEvent.setup()
    renderEditor(makeClient())

    const dialog = await openHistory(user)
    // v2 vs v1: name changed (V1 name → V2 name) and model added.
    expect(await within(dialog).findByText("Changed: name, model")).toBeInTheDocument()
    // v1 vs nothing: it set name over the defaults.
    expect(within(dialog).getByText("Changed: name")).toBeInTheDocument()
  })

  it("restores an older revision: calls the API with expectedUpdatedAt and the form re-seeds", async () => {
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config())
    vi.spyOn(personasApi, "listRevisions").mockResolvedValue(revisions)
    const restore = vi
      .spyOn(personasApi, "restoreRevision")
      .mockResolvedValue({ persona: { id: PERSONA } as never, updatedAt: "2026-07-11T03:00:00Z" })
    const user = userEvent.setup()
    renderEditor(makeClient())

    expect(screen.getByLabelText("Name")).toHaveValue("V2 name")

    const dialog = await openHistory(user)
    await user.click(within(dialog).getByRole("button", { name: "Restore version 1" }))
    const alert = await screen.findByRole("alertdialog")
    await user.click(within(alert).getByRole("button", { name: "Restore" }))

    await waitFor(() =>
      expect(restore).toHaveBeenCalledWith(WS, PERSONA, "acrev_1", { expectedUpdatedAt: "2026-07-11T02:00:00Z" })
    )
    // Cache write → harness re-render → form reconciles to the restored patch.
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("V1 name"))
  })

  it("surfaces a 409 conflict inline (INV-63) when a restore races another admin", async () => {
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config())
    vi.spyOn(personasApi, "listRevisions").mockResolvedValue(revisions)
    vi.spyOn(personasApi, "restoreRevision").mockRejectedValue(
      new ApiError(409, "PERSONA_OVERRIDE_CONFLICT", "conflict", {
        current: { patch: { name: "Theirs" }, updatedAt: "2026-07-11T05:00:00Z" },
      })
    )
    const user = userEvent.setup()
    renderEditor(makeClient())

    // Local edits present: a restore 409 keeps them and surfaces the banner,
    // exactly like Save's conflict path (a pristine form silently adopts).
    const name = screen.getByLabelText("Name")
    await user.clear(name)
    await user.type(name, "Mine")

    const dialog = await openHistory(user)
    await user.click(within(dialog).getByRole("button", { name: "Restore version 1" }))
    const alert = await screen.findByRole("alertdialog")
    await user.click(within(alert).getByRole("button", { name: "Restore" }))

    expect(await screen.findByText(/Someone else updated this persona/)).toBeInTheDocument()
    expect(screen.getByLabelText("Name")).toHaveValue("Mine")
  })

  it("restore-to-default commits an empty patch and the form re-seeds to the built-in config", async () => {
    vi.spyOn(personasApi, "getConfig").mockResolvedValue(config())
    vi.spyOn(personasApi, "listRevisions").mockResolvedValue(revisions)
    const putOverride = vi
      .spyOn(personasApi, "putOverride")
      .mockResolvedValue({ persona: { id: PERSONA } as never, updatedAt: null })
    const user = userEvent.setup()
    renderEditor(makeClient())

    expect(screen.getByLabelText("Name")).toHaveValue("V2 name")

    const dialog = await openHistory(user)
    await user.click(within(dialog).getByRole("button", { name: "Restore built-in defaults" }))
    const alert = await screen.findByRole("alertdialog")
    await user.click(within(alert).getByRole("button", { name: "Restore defaults" }))

    await waitFor(() =>
      expect(putOverride).toHaveBeenCalledWith(WS, PERSONA, { patch: {}, expectedUpdatedAt: "2026-07-11T02:00:00Z" })
    )
    // Cache reconcile → the form re-seeds to the built-in default name.
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Ariadne"))
  })
})
