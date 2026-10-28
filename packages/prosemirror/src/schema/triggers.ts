import { Node, mergeAttributes } from "@tiptap/core"
import { type Attrs, type DataAttributeSpec, dataAttr } from "./attributes"

interface TriggerNodeConfig {
  name: string
  attributes: Record<string, DataAttributeSpec>
  getText: (attrs: Attrs) => string
}

function createTriggerNode({ name, attributes, getText }: TriggerNodeConfig) {
  return Node.create({
    name,
    group: "inline",
    inline: true,
    selectable: true,
    atom: true,
    marks: "_",

    addAttributes() {
      return attributes
    },

    parseHTML() {
      return [{ tag: `span[data-type="${name}"]` }]
    },

    renderHTML({ node, HTMLAttributes }) {
      return ["span", mergeAttributes(HTMLAttributes, { "data-type": name }), getText(node.attrs)]
    },

    renderText({ node }) {
      return getText(node.attrs)
    },
  })
}

export const MentionNode = createTriggerNode({
  name: "mention",
  attributes: {
    id: dataAttr("id", "data-id", null),
    slug: dataAttr("slug", "data-slug", null),
    mentionType: dataAttr("mentionType", "data-mention-type", "user"),
  },
  getText: (attrs) => `@${attrs.slug}`,
})

export const ChannelLinkNode = createTriggerNode({
  name: "channelLink",
  attributes: {
    id: dataAttr("id", "data-id", null),
    slug: dataAttr("slug", "data-slug", null),
  },
  getText: (attrs) => `#${attrs.slug}`,
})

export const SlashCommandNode = createTriggerNode({
  name: "slashCommand",
  attributes: {
    name: dataAttr("name", "data-name", null),
    clientActionId: dataAttr("clientActionId", "data-client-action-id", null),
  },
  getText: (attrs) => `/${attrs.name}`,
})
