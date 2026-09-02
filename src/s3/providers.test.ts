import { describe, expect, it } from 'vitest'

import {
  endpointCautions,
  isLocalHost,
  providerById,
  providersInCategory,
  S3_PROVIDER_CATEGORIES,
  S3_PROVIDERS,
} from './providers.ts'
import { emptyS3Form } from './setup.ts'

describe('providers — presets', () => {
  it('resolves every id in the union', () => {
    for (const provider of S3_PROVIDERS) {
      expect(providerById(provider.id).id).toBe(provider.id)
    }
  })

  it('leaves the region editable exactly where the vendor has a choice', () => {
    expect(providerById('filebase').regionEditable).toBe(false)
    expect(providerById('r2').regionEditable).toBe(false)
    expect(providerById('aws').regionEditable).toBe(true)
    expect(providerById('garage').regionEditable).toBe(true)
    expect(providerById('seaweedfs').regionEditable).toBe(true)
  })

  it('guesses each self-hosted server’s own signing region rather than one default', () => {
    // A wrong region fails as `AuthorizationHeaderMalformed`, which reads as "my keys are wrong".
    expect(providerById('garage').region).toBe('garage')
    expect(providerById('seaweedfs').region).toBe('us-east-1')
  })

  it('names the key pair the way each vendor’s own dashboard names it', () => {
    expect(providerById('filebase').accessKeyLabel).toBe('Access token')
    expect(providerById('garage').accessKeyLabel).toBe('Key ID')
    expect(providerById('seaweedfs').accessKeyLabel).toBe('Access key')
    expect(providerById('aws').accessKeyLabel).toBe('Access key ID')
  })

  it('knows whose namespace each vendor’s bucket names live in', () => {
    expect(providerById('filebase').bucketNamespace).toBe('global')
    expect(providerById('aws').bucketNamespace).toBe('global')
    expect(providerById('r2').bucketNamespace).toBe('private')
    expect(providerById('garage').bucketNamespace).toBe('private')
    expect(providerById('other').bucketNamespace).toBe('global')
  })

  it('suggests no bucket name in the preset table', () => {
    for (const provider of S3_PROVIDERS) {
      expect(JSON.stringify(provider)).not.toContain('zs-chats')
    }
    expect(emptyS3Form('filebase').bucket).toBe('')
  })

  it('uses path-style everywhere but AWS', () => {
    expect(providerById('garage').forcePathStyle).toBe(true)
    expect(providerById('other').forcePathStyle).toBe(true)
    expect(providerById('aws').forcePathStyle).toBe(false)
  })

  it('keeps the escape hatch last, because that is what providerById falls back to', () => {
    expect(S3_PROVIDERS[S3_PROVIDERS.length - 1].id).toBe('other')
  })

  it('lists Filebase first', () => {
    expect(S3_PROVIDERS[0].id).toBe('filebase')
  })
})

describe('providers — categories', () => {
  it('reaches every preset through exactly one category', () => {
    const grouped = S3_PROVIDER_CATEGORIES.flatMap((c) =>
      providersInCategory(c.id),
    )
    expect(grouped.map((p) => p.id).sort()).toEqual(
      S3_PROVIDERS.map((p) => p.id).sort(),
    )
    expect(grouped).toHaveLength(S3_PROVIDERS.length)
  })

  it('groups exactly as the client does', () => {
    expect(providersInCategory('self-hosted').map((p) => p.id)).toEqual([
      'garage',
      'seaweedfs',
    ])
    expect(providersInCategory('hosted').map((p) => p.id)).toEqual([
      'filebase',
      'r2',
      'aws',
    ])
    expect(S3_PROVIDER_CATEGORIES.map((c) => c.id)).toEqual([
      'hosted',
      'self-hosted',
      'other',
    ])
  })
})

describe('providers — local addresses', () => {
  it('recognises loopback and the private ranges', () => {
    for (const host of [
      'localhost',
      'garage.local',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.9',
      '172.16.0.1',
      '172.31.255.254',
      '169.254.1.1',
    ]) {
      expect(isLocalHost(host)).toBe(true)
    }
  })

  it('does not mistake a public address in the 172 block for a private one', () => {
    for (const host of [
      '172.15.0.1',
      '172.32.0.1',
      '172.5.0.1',
      's3.example.com',
      '8.8.8.8',
    ]) {
      expect(isLocalHost(host)).toBe(false)
    }
  })
})

describe('providers — endpoint cautions', () => {
  it('says nothing about an ordinary https endpoint', () => {
    expect(endpointCautions('https://s3.example.com')).toEqual([])
  })

  it('calls plain http on a public host a certain failure, not a caveat', () => {
    const [caution] = endpointCautions('http://storage.example.com')
    expect(caution).toContain('every browser')
  })

  it('treats a local http address as the permission-gated case it is', () => {
    const [caution] = endpointCautions('http://localhost:9000')
    expect(caution).toContain('permission')
    expect(caution).not.toContain('every browser')
  })

  it('warns that a local https address is still not reachable from a phone', () => {
    const [caution] = endpointCautions('https://192.168.1.9:9000')
    expect(caution).toContain('phone')
  })

  it('steers a Filebase endpoint off the undocumented host', () => {
    const cautions = endpointCautions('https://s3.filebase.com')
    expect(cautions.some((line) => line.includes('s3.filebase.io'))).toBe(true)
    expect(endpointCautions('https://s3.filebase.io')).toEqual([])
  })

  it('says nothing at all about an address it cannot parse', () => {
    expect(endpointCautions('not a url')).toEqual([])
  })
})
