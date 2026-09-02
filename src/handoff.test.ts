import { describe, expect, it } from 'vitest'

import { composeHandoff, suggestBucketName } from './handoff.ts'
import { BUCKET_RE } from './s3/setup.ts'
import {
  connectionStringFromFragment,
  decodeConnectionString,
} from './s3/connection-string.ts'

const config = {
  endpoint: 'https://s3.filebase.io',
  region: 'auto',
  bucket: 'zs-abc',
  prefix: '',
  accessKeyId: 'AKID',
  secretAccessKey: 'a+b/c=d&e',
  forcePathStyle: true,
}

describe('handoff — the link', () => {
  it('carries the string in the fragment with no percent-escapes', () => {
    const { link, connectionString } = composeHandoff(
      config,
      'filebase',
      'https://zerosignal.ai',
    )
    expect(link).toBe(`https://zerosignal.ai/sync#c=${connectionString}`)
    expect(link).not.toContain('%')
    expect(new URL(link).search).toBe('')
  })

  it('survives an opener that runs encodeURI on it, and still reads on the route', () => {
    const { link, connectionString } = composeHandoff(
      config,
      'filebase',
      'https://zerosignal.ai',
    )
    const opened = new URL(encodeURI(link))
    expect(connectionStringFromFragment(opened.hash)).toBe(connectionString)
    const decoded = decodeConnectionString(
      connectionStringFromFragment(opened.hash)!,
    )
    expect(decoded.ok && decoded.config.secretAccessKey).toBe('a+b/c=d&e')
  })

  it('reduces the app URL to its origin', () => {
    expect(
      composeHandoff(config, 'other', 'https://chat.example.com/x/y').link,
    ).toMatch(/^https:\/\/chat\.example\.com\/sync#c=/)
  })
})

describe('handoff — suggested bucket name', () => {
  it('is a valid, random, zs- prefixed name', () => {
    const a = suggestBucketName()
    const b = suggestBucketName()
    expect(a).toMatch(/^zs-[a-z2-7]{8}$/)
    expect(BUCKET_RE.test(a)).toBe(true)
    expect(a).not.toBe(b)
  })
})
