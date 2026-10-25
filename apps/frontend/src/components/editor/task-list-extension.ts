import { InputRule } from "@tiptap/core"
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import { TaskList, ThreaTaskItem } from "@threahq/prosemirror/schema"

export const TaskListExtension = TaskList

// `- ` has already made a bullet item, so tiptap's wrapping rule would nest a
// task list inside it. This rule swaps that one item out of its list instead;
// toggleList cannot, because a taskList cannot hold the listItem siblings.
const bulletToTaskItemRule = new InputRule({
  find: /^\[([ xX])\]\s$/,
  handler: ({ state, range, match, chain }) => {
    const { $from } = state.selection
    if ($from.depth < 2 || $from.node(-1).type.name !== "listItem" || $from.index(-1) !== 0) return null

    const { taskList, taskItem } = state.schema.nodes
    const checked = match[1] !== " "

    chain()
      .deleteRange(range)
      .command(({ tr }) => {
        const $pos = tr.doc.resolve(tr.mapping.map(range.from))
        const item = $pos.node(-1)
        const list = $pos.node(-2)
        const listPos = $pos.before(-2)
        const index = $pos.index(-2)

        const siblings = (from: number, to: number) => {
          const nodes: ProseMirrorNode[] = []
          for (let i = from; i < to; i++) nodes.push(list.child(i))
          return nodes
        }
        const before = siblings(0, index)
        const after = siblings(index + 1, list.childCount)

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
        tr.setSelection(TextSelection.create(tr.doc, taskListPos + 3 + $pos.parentOffset))
        return true
      })
      .run()
  },
})

export const TaskItemExtension = ThreaTaskItem.extend({
  addInputRules() {
    return [...(this.parent?.() ?? []), bulletToTaskItemRule]
  },
})
