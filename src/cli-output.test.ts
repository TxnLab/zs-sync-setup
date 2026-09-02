import { describe, expect, it } from 'vitest'

import { printHandoff, probeLines } from './cli.ts'

const handoff = {
  link: 'https://zerosignal.ai/sync#c=zsmirror1%3Aabc',
  connectionString: 'zsmirror1:abc',
}

describe('cli output — the handoff', () => {
  it('writes the link and the string as single raw lines', () => {
    const lines: string[] = []
    printHandoff(handoff, (l) => lines.push(l), false)
    expect(lines).toContain(`│  ${handoff.link}\n`)
    expect(lines).toContain(`│  ${handoff.connectionString}\n`)
    // No line carries more than one newline: nothing is hard-wrapped.
    for (const line of lines) expect(line.split('\n')).toHaveLength(2)
  })

  it('wraps the link in an OSC 8 hyperlink on a TTY, with the URL as its own label', () => {
    const lines: string[] = []
    printHandoff(handoff, (l) => lines.push(l), true)
    expect(lines[1]).toContain(`]8;;${handoff.link}${handoff.link}]8;;`)
  })

  it('says what the string is', () => {
    const out: string[] = []
    printHandoff(handoff, (l) => out.push(l), false)
    expect(out.join('')).toContain('bearer credential')
  })
})

describe('cli output — probe lines', () => {
  it('marks passed, failed and not-run steps', () => {
    expect(
      probeLines({ ok: false, failedStep: 'read', kind: 'other' }),
    ).toEqual([
      '  ✓ List the bucket',
      '  ✓ Write a test object',
      '  ✗ Read it back',
      '  – Delete it',
    ])
    expect(probeLines({ ok: true }).every((l) => l.startsWith('  ✓'))).toBe(
      true,
    )
  })
})
