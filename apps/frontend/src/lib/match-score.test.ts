import { describe, it, expect } from "vitest"
import { scoreMatch, rankMatches } from "./match-score"

/** Labels that match `query`, best first. */
const ranked = (query: string, labels: string[]) => rankMatches(labels, query, (label) => ({ labels: [label] }))

describe("scoreMatch", () => {
  it("returns 0 for an empty or whitespace-only query (no scoring required)", () => {
    expect(scoreMatch("", ["View Saved"], ["bookmark"])).toBe(0)
    expect(scoreMatch("   ", ["View Saved"], ["bookmark"])).toBe(0)
  })

  it("orders the ladder: exact, whole-word prefix, whole word, mid-word prefix, anywhere", () => {
    const labels = ["no", "no_entry", "see_no_evil", "notebook", "piano"]
    expect(ranked("no", labels)).toEqual(labels)
  })

  it("treats whitespace, underscore, and dash as interchangeable separators", () => {
    for (const query of ["thumbs up", "thumbsup", "thumbs-up"]) {
      expect(scoreMatch(query, ["thumbs_up"]), query).toBeLessThan(scoreMatch("thumbs", ["thumbs_up"]))
    }
  })

  it("ranks a raw match above its separator-normalized counterpart", () => {
    expect(scoreMatch("thumbs_up", ["thumbs_up"])).toBeLessThan(scoreMatch("thumbs up", ["thumbs_up"]))
    expect(scoreMatch("thumbs", ["thumbs_up"])).toBeLessThan(scoreMatch("thumbsu", ["thumbs_up"]))
  })

  it("ranks a keyword hit below the same kind of hit on a label", () => {
    expect(scoreMatch("saved", ["Saved"])).toBeLessThan(scoreMatch("saved", ["Add To-do"], ["saved"]))
    expect(scoreMatch("sav", ["Saved"])).toBeLessThan(scoreMatch("sav", ["Add To-do"], ["saved"]))
  })

  it("ranks an exact keyword hit above an incidental label substring", () => {
    // The 'yes' → 😍 heart_eyes report: `heart_eyes` merely contains "yes",
    // while ✅ carries it as a search keyword and is what was actually meant.
    const incidentalLabelSubstring = scoreMatch("yes", ["heart_eyes"], [])
    const exactKeyword = scoreMatch("yes", ["white_check_mark"], ["yes", "check"])
    expect(exactKeyword).toBeLessThan(incidentalLabelSubstring)
  })

  it("ranks every whole-word hit above every partial one, in either field", () => {
    // `sad` must reach 😞 sad_face before 😢 cry, which merely carries "sad"
    // as a keyword — and both before 🎨 palette, which only contains it.
    const labelWholeWord = scoreMatch("sad", ["sad_face"], [])
    const keywordWholeWord = scoreMatch("sad", ["cry"], ["sad"])
    const labelPartial = scoreMatch("sad", ["saddle_up"], [])
    expect(labelWholeWord).toBeLessThan(keywordWholeWord)
    expect(keywordWholeWord).toBeLessThan(labelPartial)
  })

  it("admits fuzzy subsequence matches below every substring match", () => {
    const fuzzy = scoreMatch("thup", ["thumbs_up"])
    expect(fuzzy).not.toBe(Infinity)
    expect(fuzzy).toBeGreaterThan(scoreMatch("ave", ["Add To-do"], ["saved"]))
  })

  it("ranks a keyword substring match above a label fuzzy match", () => {
    const keywordContains = scoreMatch("humb", ["Something Else"], ["thumbs"])
    const labelFuzzy = scoreMatch("thup", ["thumbs_up"])
    expect(keywordContains).toBeLessThan(labelFuzzy)
  })

  it("ranks label fuzzy above keyword fuzzy, and compact fuzzy above scattered", () => {
    const labelFuzzy = scoreMatch("thup", ["thumbs_up"])
    const keywordFuzzy = scoreMatch("thup", ["Something Else"], ["thumbs_up"])
    // Both sides must be admitted matches — an Infinity on the right would
    // let a broken fuzzy band pass a bare lessThan comparison.
    expect(keywordFuzzy).not.toBe(Infinity)
    expect(labelFuzzy).toBeLessThan(keywordFuzzy)

    const compact = scoreMatch("cat", ["cat_face"])
    const scattered = scoreMatch("cat", ["congratulations"])
    expect(scattered).not.toBe(Infinity)
    expect(compact).toBeLessThan(scattered)
  })

  it("takes the best score across multiple labels", () => {
    expect(scoreMatch("alice", ["Alice Smith", "alice"])).toBe(0)
  })

  it("returns Infinity when nothing matches", () => {
    expect(scoreMatch("zzz", ["View Saved"], ["bookmark"])).toBe(Infinity)
    expect(scoreMatch("vwxq", ["View Saved"])).toBe(Infinity)
  })

  it("is case-insensitive on both sides", () => {
    const baseline = scoreMatch("saved", ["view saved"])
    expect(scoreMatch("SAVED", ["view saved"])).toBe(baseline)
    expect(scoreMatch("saved", ["VIEW SAVED"])).toBe(baseline)
  })

  it("handles separator-only queries without matching everything", () => {
    expect(scoreMatch("-", ["View Saved"])).toBe(Infinity)
    expect(scoreMatch("-", ["to-do"])).not.toBe(Infinity)
  })

  describe("typo tolerance", () => {
    it("admits the edit classes a subsequence cannot represent", () => {
      // Transposition and substitution each break subsequence matching
      // outright; every one of these used to return Infinity.
      for (const [query, label] of [
        ["thubms", "thumbs_up"],
        ["desing", "design-review"],
        ["recieve", "receive"],
        ["engenering", "engineering"],
        ["smiel", "smile"],
      ] as const) {
        expect(scoreMatch(query, [label]), `${query} → ${label}`).not.toBe(Infinity)
      }
    })

    it("ranks every typo match below every fuzzy and substring match", () => {
      const typo = scoreMatch("thubms", ["thumbs_up"])
      const fuzzy = scoreMatch("thup", ["thumbs_up"])
      const contains = scoreMatch("umb", ["thumbs_up"])
      expect(fuzzy).toBeLessThan(typo)
      expect(contains).toBeLessThan(fuzzy)
    })

    it("ranks a closer typo above a further one", () => {
      const oneEdit = scoreMatch("celbration", ["celebration"])
      const twoEdits = scoreMatch("celbratoin", ["celebration"])
      expect(oneEdit).not.toBe(Infinity)
      expect(twoEdits).not.toBe(Infinity)
      expect(oneEdit).toBeLessThan(twoEdits)
    })

    it("ranks a label typo above a keyword typo", () => {
      const labelTypo = scoreMatch("thubms", ["thumbs_up"])
      const keywordTypo = scoreMatch("thubms", ["Something Else"], ["thumbs_up"])
      expect(keywordTypo).not.toBe(Infinity)
      expect(labelTypo).toBeLessThan(keywordTypo)
    })

    it("spends no budget on short queries, where one edit reaches half the dataset", () => {
      expect(scoreMatch("cta", ["cat"])).toBe(Infinity)
      expect(scoreMatch("hrt", ["hat"])).toBe(Infinity)
    })

    it("anchors to whole words, so a typo cannot land mid-word in a long label", () => {
      expect(scoreMatch("hart", ["heart_eyes"])).not.toBe(Infinity)
      expect(scoreMatch("ellos", ["say_hello_to_everyone"])).toBe(Infinity)
    })
  })

  describe("quoted queries", () => {
    it("matches literally, refusing both tolerance bands", () => {
      expect(scoreMatch('"thumbs_up"', ["thumbs_up"])).toBe(0)
      expect(scoreMatch('"thup"', ["thumbs_up"])).toBe(Infinity)
      expect(scoreMatch('"thubms"', ["thumbs_up"])).toBe(Infinity)
    })

    it("refuses separator-normalized matches", () => {
      expect(scoreMatch("thumbsup", ["thumbs_up"])).not.toBe(Infinity)
      expect(scoreMatch('"thumbsup"', ["thumbs_up"])).toBe(Infinity)
    })

    it("keeps the substring ladder inside the quotes", () => {
      const labels = ["no", "no_entry", "see_no_evil", "notebook", "piano"]
      expect(ranked('"no"', labels)).toEqual(labels)
    })

    it("treats a half-typed opening quote as literal, not as a character to match", () => {
      expect(scoreMatch('"thumbs', ["thumbs_up"])).toBe(scoreMatch("thumbs", ["thumbs_up"]))
      expect(scoreMatch('"', ["thumbs_up"])).toBe(0)
    })
  })
})

describe("rankMatches", () => {
  interface Item {
    label: string
    keywords?: string[]
  }
  const text = (item: Item) => ({ labels: [item.label], keywords: item.keywords })

  it("returns the input unchanged for an empty or whitespace-only query", () => {
    const items: Item[] = [{ label: "b" }, { label: "a" }]
    expect(rankMatches(items, "", text)).toEqual(items)
    expect(rankMatches(items, "  ", text)).toEqual(items)
  })

  it("drops non-matches", () => {
    const items: Item[] = [{ label: "View Saved" }, { label: "Open Memory" }]
    expect(rankMatches(items, "saved", text)).toEqual([{ label: "View Saved" }])
  })

  it("ranks a label match above an earlier-defined keyword-only match", () => {
    const todo: Item = { label: "Add To-do", keywords: ["saved"] }
    const saved: Item = { label: "Saved", keywords: ["bookmark"] }
    expect(rankMatches([todo, saved], "saved", text)).toEqual([saved, todo])
  })

  it("preserves input order within a tier (stable)", () => {
    const items: Item[] = [{ label: "saver" }, { label: "saved" }]
    // Both are mid-word label-prefix matches for "save"; definition order decides.
    expect(rankMatches(items, "save", text)).toEqual(items)
  })

  it("appends fuzzy matches after substring matches", () => {
    const items: Item[] = [{ label: "thumbs_up" }, { label: "setup" }, { label: "sun_with_face" }]
    // "setup" contains "tup" raw; "thumbs_up" only matches as a subsequence.
    expect(rankMatches(items, "tup", text)).toEqual([{ label: "setup" }, { label: "thumbs_up" }])
  })

  it("appends typo matches last of all", () => {
    const items: Item[] = [{ label: "receiver" }, { label: "recieve" }, { label: "receive" }]
    // "recieve" is an exact hit; "receiver"/"receive" are one transposition away.
    expect(rankMatches(items, "recieve", text)[0]).toEqual({ label: "recieve" })
  })
})
