import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Switch } from "@/components/ui/switch"
import * as mobileModule from "@/hooks/use-mobile"
import * as pointerModule from "@/hooks/use-pointer"
import {
  ChoiceSetting,
  FOLD_AT_HEIGHT,
  FoldSetting,
  type FoldChoice,
  NumberField,
  NumberSetting,
  SettingFieldError,
  SettingGroupBand,
  SettingLinkRow,
  SettingRemoveButton,
  SettingRow,
  SettingScopeBadges,
  SettingStateAction,
  SettingValue,
  SettingsDisclosure,
  SettingsDisclosureTrigger,
  SwitchSetting,
  settingIds,
  SaveError,
} from "./setting-primitives"
import { settingDef } from "./settings-registry"

function mountFileInsert(onCheckedChange = vi.fn()) {
  render(<SwitchSetting setting="file-insert" checked={false} onCheckedChange={onCheckedChange} />)
  return { onCheckedChange, row: document.getElementById(settingIds("file-insert").row)! }
}

describe("SwitchSetting", () => {
  it("toggles from a tap anywhere on its text and keeps badges out of the switch's name", async () => {
    const user = userEvent.setup()
    const { onCheckedChange } = mountFileInsert()

    await user.click(screen.getByText("Picked files land where you're typing instead of in the tray above."))

    expect({
      toggled: onCheckedChange.mock.calls,
      name: screen.getByRole("switch").getAttribute("aria-labelledby"),
      phones: screen.getByText("Phones") !== null,
    }).toEqual({ toggled: [[true]], name: settingIds("file-insert").label, phones: true })
    expect(screen.getByRole("switch")).toHaveAccessibleName("Insert files at the cursor")
  })
})

describe("ChoiceSetting", () => {
  const options = [
    { value: "auto", label: "Automatic", description: "Picks for you." },
    { value: "on", label: "Always" },
  ] as const

  it("keeps the setting's own description and adds the chosen option's, with the scope badge, to the control's description", () => {
    const { rerender } = render(
      <ChoiceSetting setting="call-mirror" variant="segmented" value="auto" options={options} onValueChange={vi.fn()} />
    )
    const ids = settingIds("call-mirror")
    const described = () => document.getElementById(ids.description)?.textContent
    const withOption = described()
    rerender(
      <ChoiceSetting setting="call-mirror" variant="segmented" value="on" options={options} onValueChange={vi.fn()} />
    )

    expect({
      withOption,
      withoutOption: described(),
      describedBy: screen.getByRole("radiogroup").getAttribute("aria-describedby"),
    }).toEqual({
      withOption: `${settingDef("call-mirror").description}Picks for you.`,
      withoutOption: settingDef("call-mirror").description,
      describedBy: `${ids.description} ${ids.scope}`,
    })
    expect(screen.getByRole("radiogroup")).toHaveAccessibleDescription(expect.stringContaining("This device"))
  })
})

describe("SwitchSetting inactive", () => {
  it("keeps the switch focusable, aria-disabled and pointed at the reason, and ignores a press", async () => {
    const onCheckedChange = vi.fn()
    const user = userEvent.setup()
    render(
      <SwitchSetting
        setting="file-insert"
        checked={false}
        onCheckedChange={onCheckedChange}
        inactive="Turn on X first."
      />
    )
    const toggle = screen.getByRole("switch")
    await user.tab()
    await user.keyboard(" ")

    expect({
      focused: document.activeElement === toggle,
      nativeDisabled: (toggle as HTMLButtonElement).disabled,
      ariaDisabled: toggle.getAttribute("aria-disabled"),
      reason: toggle.getAttribute("aria-describedby")?.split(" ").includes(settingIds("file-insert").reason),
      changes: onCheckedChange.mock.calls,
    }).toEqual({ focused: true, nativeDisabled: false, ariaDisabled: "true", reason: true, changes: [] })
  })
})

describe("landing target", () => {
  it("rings a row focused by code, and not one focused by a click into its blank space", () => {
    const { row } = mountFileInsert()

    row.focus()
    const landed = row.dataset.landed
    row.blur()
    fireEvent.pointerDown(row)
    row.focus()

    expect({ landed, afterBlur: row.dataset.landed }).toEqual({ landed: "true", afterBlur: undefined })
  })
})

describe("SettingScopeBadges", () => {
  it("shows the Keyboards chip only on a touch-only device", () => {
    const fine = render(<SettingScopeBadges appliesOn="keyboards" />)
    const onFine = fine.queryByText("Keyboards")
    fine.unmount()
    vi.spyOn(pointerModule, "useCoarsePointer").mockReturnValue(true)
    render(<SettingScopeBadges appliesOn="keyboards" />)

    expect({ onFine, onTouch: screen.queryByText("Keyboards") !== null }).toEqual({ onFine: null, onTouch: true })
    vi.restoreAllMocks()
  })
  it("shows the Desktop layout chip only while this device uses the phone layout", () => {
    const desktop = render(<SettingScopeBadges appliesOn="desktop" />)
    const onDesktop = desktop.queryByText("Desktop layout")
    desktop.unmount()
    vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(true)
    render(<SettingScopeBadges appliesOn="desktop" />)

    expect({ onDesktop, onPhone: screen.queryByText("Desktop layout") !== null }).toEqual({
      onDesktop: null,
      onPhone: true,
    })
    vi.restoreAllMocks()
  })
})

describe("NumberSetting", () => {
  function mountLedgerRows(onCommit = vi.fn()) {
    render(<NumberSetting setting="board-ledger-rows" value={5} min={1} max={20} onCommit={onCommit} />)
    return { onCommit, field: screen.getByRole("spinbutton", { name: settingDef("board-ledger-rows").label }) }
  }

  it("announces its range without showing it, and keeps an out-of-range entry in the field with an error instead of saving it", async () => {
    const user = userEvent.setup()
    const { onCommit, field } = mountLedgerRows()
    expect(field).toHaveAccessibleDescription(expect.stringContaining("From 1 to 20."))
    expect(screen.queryByText("1–20")).toBeNull()
    await user.clear(field)
    await user.type(field, "99{Enter}")

    expect({
      commits: onCommit.mock.calls,
      value: (field as HTMLInputElement).value,
      invalid: field.getAttribute("aria-invalid"),
      error: screen.getByRole("alert").textContent,
    }).toEqual({ commits: [], value: "99", invalid: "true", error: "Enter a whole number from 1 to 20." })
    expect(field).toHaveAccessibleDescription(expect.stringContaining("Enter a whole number from 1 to 20."))
  })

  it("rejects a fraction or a blank, and saves once the entry is fixed", async () => {
    const user = userEvent.setup()
    const { onCommit, field } = mountLedgerRows()
    await user.clear(field)
    await user.type(field, "2.5")
    await user.tab()
    const afterFraction = screen.queryByRole("alert")?.textContent
    await user.clear(field)
    await user.type(field, "12")
    const whileFixed = screen.queryByRole("alert")
    await user.tab()

    expect({
      afterFraction,
      whileFixed,
      commits: onCommit.mock.calls,
      invalid: field.getAttribute("aria-invalid"),
    }).toEqual({
      afterFraction: "Enter a whole number from 1 to 20.",
      whileFixed: null,
      commits: [[12]],
      invalid: null,
    })
  })
})

describe("NumberSetting drafts", () => {
  function mount(onCommit = vi.fn()) {
    const view = render(<NumberSetting setting="board-ledger-rows" value={5} min={1} max={20} onCommit={onCommit} />)
    const field = screen.getByRole("spinbutton", { name: settingDef("board-ledger-rows").label }) as HTMLInputElement
    return { onCommit, field, unmount: view.unmount }
  }

  it("saves a valid draft when it closes without a blur, and drops an invalid one", async () => {
    const user = userEvent.setup()
    const valid = mount()
    await user.clear(valid.field)
    await user.type(valid.field, "12")
    valid.unmount()
    const invalid = mount()
    await user.clear(invalid.field)
    await user.type(invalid.field, "99")
    invalid.unmount()

    expect({ valid: valid.onCommit.mock.calls, invalid: invalid.onCommit.mock.calls }).toEqual({
      valid: [[12]],
      invalid: [],
    })
  })

  it("reverts a typed draft on Escape without letting the window see the key", async () => {
    const user = userEvent.setup()
    const { onCommit, field } = mount()
    await user.clear(field)
    await user.type(field, "99")
    const outerEscape = vi.fn()
    document.addEventListener("keydown", outerEscape, { capture: true })
    await user.keyboard("{Escape}")
    const afterRevert = { value: field.value, alert: screen.queryByRole("alert"), outer: outerEscape.mock.calls.length }
    await user.keyboard("{Escape}")
    document.removeEventListener("keydown", outerEscape, { capture: true })
    await user.tab()

    expect({
      afterRevert,
      cleanEscapeReachesWindow: outerEscape.mock.calls.length,
      commits: onCommit.mock.calls,
    }).toEqual({
      afterRevert: { value: "5", alert: null, outer: 0 },
      cleanEscapeReachesWindow: 1,
      commits: [],
    })
  })
})

describe("FoldSetting", () => {
  it("is one segmented choice with the height a row of its own, which picks Taller than only through a valid commit", async () => {
    const user = userEvent.setup()
    const onChoiceChange = vi.fn()
    const onCommit = vi.fn()
    function Harness() {
      const [choice, setChoice] = useState<FoldChoice>("never")
      return (
        <FoldSetting
          setting="board-card-collapse"
          atSetting="board-card-collapse-at"
          noun={{ one: "card", many: "cards" }}
          choice={choice}
          onChoiceChange={(next) => {
            onChoiceChange(next)
            setChoice(next)
          }}
          value={450}
          min={100}
          max={2000}
          unit="px"
          onCommit={(height) => {
            onCommit(height)
            setChoice(FOLD_AT_HEIGHT)
          }}
        />
      )
    }
    render(<Harness />)
    const height = screen.getByRole("spinbutton", { name: settingDef("board-card-collapse-at").label })
    await user.clear(height)
    await user.keyboard("{Escape}")
    await user.type(height, "50")
    await user.tab()
    const invalid = screen.getByRole("radio", { name: "Taller than" }).getAttribute("data-state")
    await user.clear(height)
    await user.type(height, "900")
    await user.tab()

    expect({
      options: screen.getAllByRole("radio").map((radio) => radio.textContent),
      invalid,
      at: screen.getByRole("radio", { name: "Taller than" }).getAttribute("data-state"),
      commits: onCommit.mock.calls,
      choices: onChoiceChange.mock.calls,
      heightRow: height.closest(`#${settingIds("board-card-collapse-at").row}`) !== null,
      dependent: height.closest(`[data-dependents-of="board-card-collapse"]`) !== null,
    }).toEqual({
      options: ["Never", "Taller than"],
      invalid: "unchecked",
      at: "checked",
      commits: [[900]],
      choices: [],
      heightRow: true,
      dependent: true,
    })
    expect(screen.getByText("Cards over the limit below start collapsed.")).toBeInTheDocument()
  })

  it("keeps the height typed when another choice is picked", async () => {
    const user = userEvent.setup()
    const onChoiceChange = vi.fn()
    const onCommit = vi.fn()
    render(
      <FoldSetting
        setting="code-collapse"
        atSetting="code-collapse-at"
        noun={{ one: "code block", many: "code blocks" }}
        always
        choice={FOLD_AT_HEIGHT}
        onChoiceChange={onChoiceChange}
        value={10}
        min={1}
        max={500}
        unit="lines"
        onCommit={onCommit}
      />
    )
    const height = screen.getByRole("spinbutton", { name: settingDef("code-collapse-at").label })
    await user.clear(height)
    await user.type(height, "25")
    await user.click(screen.getByRole("radio", { name: "Always" }))

    expect({
      group: screen.getByRole("radiogroup").getAttribute("aria-labelledby"),
      commits: onCommit.mock.calls,
      choices: onChoiceChange.mock.calls,
    }).toEqual({ group: settingIds("code-collapse").label, commits: [[25]], choices: [["always"]] })
  })
})

describe("radio list option target", () => {
  it("chooses an option from its label, but not from a trailing field, which stays outside the label", async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <ChoiceSetting<"none" | "count">
        setting="link-preview-count"
        variant="list"
        value="none"
        onValueChange={onValueChange}
        options={[
          { value: "none", label: "None", description: "Previews start collapsed." },
          {
            value: "count",
            label: "First",
            description: "Later links start collapsed.",
            trailing: <NumberField id="count" aria-label="How many" value={3} min={1} max={50} onCommit={vi.fn()} />,
          },
        ]}
      />
    )
    const count = screen.getByRole("spinbutton", { name: "How many" })
    await user.click(count)
    const afterFieldClick = onValueChange.mock.calls.length
    await user.click(screen.getByRole("radio", { name: "First" }).closest("label")!)

    expect({
      fieldInLabel: count.closest("label") !== null,
      afterFieldClick,
      choices: onValueChange.mock.calls,
    }).toEqual({ fieldInLabel: false, afterFieldClick: 0, choices: [["count"]] })
  })
})

describe("SwitchSetting error", () => {
  it("shows a failed save under the row and describes the switch with it", () => {
    render(
      <SwitchSetting
        setting="file-insert"
        checked={false}
        onCheckedChange={vi.fn()}
        error="Couldn't save. Try again."
      />
    )
    const alert = screen.getByRole("alert")
    expect({ text: alert.textContent, id: alert.id }).toEqual({
      text: "Couldn't save. Try again.",
      id: settingIds("file-insert").error,
    })
    expect(screen.getByRole("switch")).toHaveAccessibleDescription(expect.stringContaining("Couldn't save. Try again."))
  })
})

describe("SettingFieldError", () => {
  it("is announced as an alert, and a failed save shows through it", () => {
    render(
      <>
        <SettingFieldError id="name-error">Enter a name.</SettingFieldError>
        <SaveError id="bio-error" state={{ kind: "error", message: "Couldn't save" }} />
        <SaveError state={{ kind: "saved" }} />
      </>
    )

    expect(screen.getAllByRole("alert").map((alert) => [alert.id, alert.textContent])).toEqual([
      ["name-error", "Enter a name."],
      ["bio-error", "Couldn't save"],
    ])
  })
})

describe("SettingRow notice", () => {
  it("shows the notice under the description as its own describable line", () => {
    render(<SettingRow setting="file-insert" notice="Your workspace has no working hours." />)

    expect(document.getElementById(settingIds("file-insert").notice)?.textContent).toBe(
      "Your workspace has no working hours."
    )
  })
})

describe("SettingRow with its own label", () => {
  it("lays out like a setting row but stays out of search landing, and names a switch through its anchor", async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    const ids = settingIds("bot-reads")
    const { container } = render(
      <>
        <SettingRow label="Picture" description="JPEG or PNG." />
        <SettingRow
          label="Read everything you can read"
          description="Except encrypted streams."
          anchor="bot-reads"
          toggle
          control={
            <Switch
              id={ids.control}
              aria-labelledby={ids.label}
              aria-describedby={ids.description}
              onCheckedChange={onCheckedChange}
            />
          }
        />
      </>
    )
    await user.click(screen.getByText("Except encrypted streams."))

    expect({
      landingRows: container.querySelectorAll("[data-setting]").length,
      picture: screen.getByText("JPEG or PNG.").textContent,
      toggled: onCheckedChange.mock.calls,
    }).toEqual({ landingRows: 0, picture: "JPEG or PNG.", toggled: [[true]] })
    expect(screen.getByRole("switch", { name: "Read everything you can read" })).toHaveAccessibleDescription(
      "Except encrypted streams."
    )
  })
})

describe("SettingValue", () => {
  it("shows the value, or its muted placeholder when there is none", () => {
    render(
      <>
        <SettingValue id="region">Europe</SettingValue>
        <SettingValue id="phone">{""}</SettingValue>
        <SettingValue id="agent" placeholder="None" />
      </>
    )

    expect(["region", "phone", "agent"].map((id) => document.getElementById(id)?.textContent)).toEqual([
      "Europe",
      "Not set",
      "None",
    ])
  })
})

describe("one value grammar", () => {
  it("keeps a read-only value on one line, and a clipped one opens to its whole text from a click, a tap or the keyboard, with no hover title", async () => {
    const user = userEvent.setup()
    const value = "a.very.long.address@an-even-longer-company-domain.example"
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.textContent === value ? 500 : 0
    })
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200)
    render(
      <>
        <SettingValue id="email">{value}</SettingValue>
        <SettingValue id="region">EU</SettingValue>
      </>
    )
    const clipped = screen.getByRole("button", { name: value })
    const before = { expanded: clipped.getAttribute("aria-expanded"), title: clipped.getAttribute("title") }
    clipped.focus()
    await user.keyboard("{Enter}")

    expect({
      before,
      after: clipped.getAttribute("aria-expanded"),
      region: { button: screen.queryByRole("button", { name: "EU" }), title: document.getElementById("region")?.title },
    }).toEqual({
      before: { expanded: "false", title: null },
      after: "true",
      region: { button: null, title: "" },
    })
    vi.restoreAllMocks()
  })

  it("keeps link and disclosure values on one line, cut off rather than wrapped, still read whole", () => {
    render(
      <MemoryRouter>
        <SettingLinkRow setting="working-hours" href="?settings=datetime" value="Mon–Fri 09:00–17:00" />
        <Collapsible>
          <SettingsDisclosureTrigger heading="Older messages" summary="1 newest in full, then 15 one-line summaries" />
        </Collapsible>
      </MemoryRouter>
    )
    const value = (text: string) => screen.getByText(text)

    expect({
      link: [...value("Mon–Fri 09:00–17:00").classList].filter(
        (name) => name === "truncate" || name.includes("anywhere")
      ),
      disclosure: [...value("1 newest in full, then 15 one-line summaries").classList].filter(
        (name) => name === "truncate" || name.includes("anywhere")
      ),
      linkName: screen.getByRole("link").textContent?.includes("Mon–Fri 09:00–17:00"),
    }).toEqual({ link: ["truncate"], disclosure: ["truncate"], linkName: true })
  })
})

describe("SettingStateAction", () => {
  it("describes its button by the state sentence", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <SettingStateAction action={{ children: "Use this device's time zone", onClick }}>
        This device is on Stockholm.
      </SettingStateAction>
    )
    const button = screen.getByRole("button", { name: "Use this device's time zone" })
    await user.click(button)

    expect({ clicks: onClick.mock.calls.length }).toEqual({ clicks: 1 })
    expect(button).toHaveAccessibleDescription("This device is on Stockholm.")
  })
})

describe("SettingStateAction with a link", () => {
  it("goes somewhere instead of acting, described by the same sentence", () => {
    render(
      <MemoryRouter>
        <SettingStateAction action={{ href: "/api/connect", reloadDocument: true, children: "Connect GitHub" }}>
          Not connected.
        </SettingStateAction>
      </MemoryRouter>
    )
    const link = screen.getByRole("link", { name: "Connect GitHub" })

    expect({ href: link.getAttribute("href"), buttons: screen.queryAllByRole("button") }).toEqual({
      href: "/api/connect",
      buttons: [],
    })
    expect(link).toHaveAccessibleDescription("Not connected.")
  })
})

describe("SettingLinkRow", () => {
  it("is one link to its place, landing on the setting's anchor, and plain text when there's nowhere to go", () => {
    render(
      <MemoryRouter>
        <SettingLinkRow setting="spend-limits" href="/w/ws_1/usage" value="$3 of $10 this month" />
        <ul>
          <li>
            <SettingLinkRow label="Model" description="Edited by workspace admins" value="Claude" href={null} />
          </li>
        </ul>
      </MemoryRouter>
    )
    const row = document.getElementById(settingIds("spend-limits").row)!

    expect({
      links: screen.getAllByRole("link").map((link) => link.getAttribute("href")),
      linkInAnchor: row.querySelector("a") !== null,
      landing: row.tabIndex,
      unlinked: screen.getByRole("listitem").textContent,
    }).toEqual({
      links: ["/w/ws_1/usage"],
      linkInAnchor: true,
      landing: -1,
      unlinked: "ModelEdited by workspace adminsClaude",
    })
  })
})

describe("SettingsDisclosure", () => {
  it("opens from its trigger to show what it holds", async () => {
    const user = userEvent.setup()
    render(
      <SettingsDisclosure setting="link-preview-types" summary="No overrides">
        <p>Per type</p>
      </SettingsDisclosure>
    )
    const trigger = screen.getByRole("button", { name: new RegExp(settingDef("link-preview-types").label) })
    await user.click(trigger)

    expect({ expanded: trigger.getAttribute("aria-expanded"), shown: screen.queryByText("Per type") !== null }).toEqual(
      {
        expanded: "true",
        shown: true,
      }
    )
  })

  it("lends its trigger to a disclosure of its own", async () => {
    const user = userEvent.setup()
    render(
      <Collapsible>
        <SettingsDisclosureTrigger heading="Changed from default" summary="3 settings" />
        <CollapsibleContent>Rows</CollapsibleContent>
      </Collapsible>
    )
    await user.click(screen.getByRole("button", { name: /Changed from default/ }))

    expect(screen.getByText("Rows")).toBeInTheDocument()
  })
})

describe("SettingGroupBand", () => {
  it("names the rows it groups", () => {
    render(
      <SettingGroupBand label="Navigation">
        <SettingRow setting="file-insert" />
      </SettingGroupBand>
    )

    expect(screen.getByRole("group", { name: "Navigation" })).toContainElement(
      document.getElementById(settingIds("file-insert").row)
    )
  })
})

describe("SettingRemoveButton", () => {
  it("names what it removes", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<SettingRemoveButton label="Remove Python override" onClick={onClick} />)
    await user.click(screen.getByRole("button", { name: "Remove Python override" }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
