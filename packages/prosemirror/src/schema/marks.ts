import { Code } from "@tiptap/extension-code"
import Link from "@tiptap/extension-link"

// Markdown, the timeline renderer and stored bodies all carry bold/link code
// (`**\`x\`**`); only TipTap's default `excludes: "_"` forbade it.
export const ThreaCode = Code.extend({
  excludes: "",
})

// Typing at a link's end continues outside it.
export const ThreaLink = Link.extend({
  exitable: false,

  inclusive() {
    return false
  },
})
