import { InputRule } from "@tiptap/core"
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import { ThreaTaskItem } from "@threahq/prosemirror/schema"

// `- ` has already made a bullet item, so tiptap's wrapping rule would nest a
// task list inside it. This rule swaps that one item out of its list instead;
// toggleList cannot, because a taskList cannot hold the listItem siblings.
const bulletItemToTaskItemRule = new InputRule({
  find: /^\[([ xX]?)\]\s$/,
  handler: ({ state, range, match, chain }) => {
    const { $from } = state.selection
    if (
      $from.depth < 2 ||
      $from.node(-1).type.name !== "listItem" ||
      $from.node(-2).type.name !== "bulletList" ||
      $from.index(-1) !== 0
    ) {
      return null
    }

    const { taskList, taskItem } = state.schema.nodes
    const checked = /x/i.test(match[1])

    chain()
      .deleteRange(range)
      .command(({ tr }) => {
        const $pos = tr.doc.resolve(tr.mapping.map(range.from))
        const item = $pos.node(-1)
        const list = $pos.node(-2)
        const listPos = $pos.before(-2)
        const index = $pos.index(-2)

        const before = list.children.slice(0, index)
        const after = list.children.slice(index + 1)

        const replacement: ProseMirrorNode[] = []
        if (before.length > 0) replacement.push(list.type.create(list.attrs, before))
        replacement.push(
          taskList.create({ blockId: before.length > 0 ? null : list.attrs.blockId }, [
            taskItem.create({ ...item.attrs, checked }, item.content),
          ])
        )
        if (after.length > 0) replacement.push(list.type.create({ ...list.attrs, blockId: null }, after))

        tr.replaceWith(listPos, listPos + list.nodeSize, Fragment.from(replacement))
        const taskListPos = listPos + (before.length > 0 ? replacement[0].nodeSize : 0)
        // Inside taskList > taskItem > paragraph; the range delete left the caret at its start.
        const taskTextStart = taskListPos + 3
        tr.setSelection(TextSelection.create(tr.doc, taskTextStart))
        return true
      })
      .run()
  },
})

export const TaskItemExtension = ThreaTaskItem.extend({
  addInputRules() {
    return [...(this.parent?.() ?? []), bulletItemToTaskItemRule]
  },

  // tiptap's toggle focuses the editor, which on a phone raises the keyboard for a tap that only meant to check a box.
  addNodeView() {
    const render = this.parent?.()
    if (!render) return null
    return (props) => {
      const view = render(props)
      const item = view.dom as HTMLElement
      const checkbox = item.querySelector<HTMLInputElement>(":scope > label > input[type=checkbox]")
      // Capturing on the item runs ahead of tiptap's listener on the checkbox, which stopPropagation then skips.
      item.addEventListener(
        "change",
        (event) => {
          const pos = props.getPos()
          if (event.target !== checkbox || !checkbox || !props.editor.isEditable || typeof pos !== "number") return
          event.stopPropagation()
          const { tr } = props.editor.state
          tr.setNodeAttribute(pos, "checked", checkbox.checked)
          props.editor.view.dispatch(tr)
        },
        { capture: true }
      )
      return view
    }
  },
})
