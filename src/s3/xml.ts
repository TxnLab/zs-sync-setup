// Just enough XML to read S3 responses. Node has no `DOMParser`, and every
// document this tool reads is a flat tree of known element names, so a tag
// extractor covers it without a dependency.

import { MirrorIOError } from './errors.ts'

const ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
}

export function unescapeXml(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g,
    (whole, body: string) => {
      if (body.startsWith('#x'))
        return String.fromCodePoint(parseInt(body.slice(2), 16))
      if (body.startsWith('#'))
        return String.fromCodePoint(parseInt(body.slice(1), 10))
      return ENTITIES[body] ?? whole
    },
  )
}

function openTag(tag: string): RegExp {
  // `<Key>` and `<Key attr="…">` but not `<KeyCount>` or `<Key/>`.
  return new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g')
}

function closeTag(tag: string): RegExp {
  return new RegExp(`</${tag}\\s*>`, 'g')
}

/** Inner text of every non-nested `<tag>…</tag>` block, in document order. */
export function blocksOf(xml: string, tag: string): string[] {
  const out: string[] = []
  const open = openTag(tag)
  const close = closeTag(tag)
  let match: RegExpExecArray | null
  while ((match = open.exec(xml)) !== null) {
    const start = match.index + match[0].length
    close.lastIndex = start
    const end = close.exec(xml)
    if (!end) break
    out.push(xml.slice(start, end.index))
    open.lastIndex = end.index + end[0].length
  }
  return out
}

/** Unescaped text of the first `<tag>…</tag>`; empty when absent or self-closing. */
export function textOf(xml: string, tag: string): string {
  const [first] = blocksOf(xml, tag)
  return first === undefined ? '' : unescapeXml(first.trim())
}

/**
 * A malformed document must not read as an empty one: a truncated listing
 * would otherwise mean "the bucket has no files".
 */
export function assertWellFormed(xml: string, root: string): void {
  openTag(root).lastIndex = 0
  const opened = openTag(root).test(xml)
  const closed = closeTag(root).test(xml) || /<[^>]+\/>\s*$/.test(xml.trim())
  if (!opened || !closed) throw new MirrorIOError('other', 'MalformedXml')
}
