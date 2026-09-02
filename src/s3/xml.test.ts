import { describe, expect, it } from 'vitest'

import { MirrorIOError } from './errors.ts'
import { assertWellFormed, blocksOf, textOf, unescapeXml } from './xml.ts'

describe('xml — extraction', () => {
  it('reads the first matching element, unescaped', () => {
    expect(textOf('<a><Key>a &amp; b</Key><Key>c</Key></a>', 'Key')).toBe(
      'a & b',
    )
  })

  it('does not mistake a longer tag name for a shorter one', () => {
    // `<KeyCount>` must not satisfy a search for `<Key>`.
    expect(textOf('<r><KeyCount>3</KeyCount><Key>k</Key></r>', 'Key')).toBe('k')
  })

  it('tolerates attributes and namespaces on the element', () => {
    expect(
      textOf('<Root xmlns="urn:x"><Prefix a="1">p</Prefix></Root>', 'Prefix'),
    ).toBe('p')
  })

  it('reads a self-closing or empty element as empty', () => {
    expect(textOf('<r><Prefix/></r>', 'Prefix')).toBe('')
    expect(textOf('<r><Prefix></Prefix></r>', 'Prefix')).toBe('')
    expect(textOf('<r></r>', 'Prefix')).toBe('')
  })

  it('returns each block in order', () => {
    const xml =
      '<r><Contents><Key>a</Key></Contents><Contents><Key>b</Key></Contents></r>'
    expect(blocksOf(xml, 'Contents').map((b) => textOf(b, 'Key'))).toEqual([
      'a',
      'b',
    ])
  })

  it('decodes named and numeric entities', () => {
    expect(unescapeXml('&lt;&gt;&amp;&quot;&apos;&#65;&#x42;')).toBe('<>&"\'AB')
    expect(unescapeXml('&unknown;')).toBe('&unknown;')
  })
})

describe('xml — well-formedness', () => {
  it('rejects a truncated document instead of reading it as empty', () => {
    expect(() =>
      assertWellFormed('<ListBucketResult><oops', 'ListBucketResult'),
    ).toThrow(MirrorIOError)
    expect(() =>
      assertWellFormed('<Other></Other>', 'ListBucketResult'),
    ).toThrow(MirrorIOError)
  })

  it('accepts a complete document', () => {
    expect(() =>
      assertWellFormed(
        '<ListBucketResult xmlns="x"></ListBucketResult>',
        'ListBucketResult',
      ),
    ).not.toThrow()
  })
})
