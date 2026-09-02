import { describe, expect, it } from 'vitest'

import { runBucketSetup, type StepResult } from './bucket-setup.ts'
import { PROVIDER_NOTES } from './provider-notes.ts'
import type { S3MirrorConfig } from './s3/client.ts'
import type { S3ProviderId } from './s3/providers.ts'
import { createFakeBucket } from './test/fake-bucket.ts'

const BUCKET = 'zs-test'

function config(overrides: Partial<S3MirrorConfig> = {}): S3MirrorConfig {
  return {
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: BUCKET,
    prefix: '',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    forcePathStyle: true,
    ...overrides,
  }
}

const FILEBASE = config({ endpoint: 'https://s3.filebase.io', region: 'auto' })

function run(
  bucket = createFakeBucket(BUCKET),
  providerId: S3ProviderId = 'other',
  cfg = config(),
) {
  return runBucketSetup(
    { config: cfg, providerId, origins: ['*'] },
    { fetchImpl: bucket.fetch },
  )
}

function byId(steps: StepResult[], id: StepResult['id']): StepResult {
  const step = steps.find((s) => s.id === id)
  if (!step) throw new Error(`no step ${id}`)
  return step
}

describe('bucket setup — the happy path', () => {
  it('passes every step on an existing, empty bucket', async () => {
    const bucket = createFakeBucket(BUCKET)
    const outcome = await run(bucket)
    expect(outcome.ok).toBe(true)
    expect(outcome.steps.map((s) => [s.id, s.status])).toEqual([
      ['bucket', 'ok'],
      ['bucket-type', 'skip'],
      ['cors', 'ok'],
      ['versioning', 'ok'],
      ['probe', 'ok'],
    ])
    expect(bucket.cors()).toContain('<AllowedMethod>DELETE</AllowedMethod>')
    expect(bucket.keys()).toEqual([])
  })

  it('creates a missing bucket, then finds it on the next run', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.setExists(false)
    const first = await run(bucket)
    expect(first.ok).toBe(true)
    expect(byId(first.steps, 'bucket').detail).toContain('Created')
    expect(bucket.count('CreateBucket')).toBe(1)

    const second = await run(bucket)
    expect(second.ok).toBe(true)
    expect(byId(second.steps, 'bucket').detail).toContain('exists')
    expect(bucket.count('CreateBucket')).toBe(1)
    // Same verdicts both times: every step is safe to repeat.
    expect(second.steps.map((s) => [s.id, s.status])).toEqual(
      first.steps.map((s) => [s.id, s.status]),
    )
    expect(bucket.keys()).toEqual([])
  })

  it('reports each step as it completes', async () => {
    const seen: string[] = []
    await runBucketSetup(
      { config: config(), providerId: 'other', origins: ['*'] },
      {
        fetchImpl: createFakeBucket(BUCKET).fetch,
        onStep: (s) => seen.push(s.id),
      },
    )
    expect(seen).toEqual([
      'bucket',
      'bucket-type',
      'cors',
      'versioning',
      'probe',
    ])
  })

  it('narrows the CORS rule to the requested origins', async () => {
    const bucket = createFakeBucket(BUCKET)
    await runBucketSetup(
      {
        config: config(),
        providerId: 'other',
        origins: ['https://zerosignal.ai'],
      },
      { fetchImpl: bucket.fetch },
    )
    expect(bucket.cors()).toContain(
      '<AllowedOrigin>https://zerosignal.ai</AllowedOrigin>',
    )
    expect(bucket.cors()).not.toContain('<AllowedOrigin>*</AllowedOrigin>')
  })
})

describe('bucket setup — the bucket step', () => {
  it('stops when the endpoint cannot be reached', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.blockNetwork()
    const outcome = await run(bucket)
    expect(outcome.ok).toBe(false)
    expect(outcome.steps).toHaveLength(1)
    expect(outcome.steps[0].detail).toContain('Could not reach')
    expect(outcome.steps[0].detail).toContain('not CORS')
  })

  it('refuses to create on a console-only provider, and says where to go', async () => {
    expect(PROVIDER_NOTES.filebase.createMissing).toBe('console-only')
    const bucket = createFakeBucket(BUCKET)
    bucket.setExists(false)
    const outcome = await run(bucket, 'filebase', FILEBASE)
    expect(outcome.ok).toBe(false)
    expect(bucket.count('CreateBucket')).toBe(0)
    expect(outcome.steps[0].fix).toContain('console.filebase.com')
    expect(outcome.steps[0].fix).toContain('S3-type')
    expect(outcome.steps[0].fix).toContain('re-run the same command')
  })

  it('names the token scope when R2 refuses to create', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.setExists(false)
    bucket.failOp('CreateBucket', 403, 'AccessDenied')
    const outcome = await run(bucket, 'r2', config({ region: 'auto' }))
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].fix).toContain('Admin Read & Write')
    expect(outcome.steps[0].http).toEqual({ status: 403, code: 'AccessDenied' })
  })

  it('tells a taken name apart from a refused creation', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.setExists(false)
    bucket.failOp('CreateBucket', 409, 'BucketAlreadyExists')
    const outcome = await run(bucket)
    expect(outcome.steps[0].detail).toContain('taken')
  })

  it('treats BucketAlreadyOwnedByYou as existing', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.failOp('HeadBucket', 404, 'NoSuchBucket')
    const outcome = await run(bucket)
    expect(byId(outcome.steps, 'bucket').status).toBe('ok')
  })

  it('reads a redirect as the wrong region', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.failOp('HeadBucket', 301, 'PermanentRedirect')
    const outcome = await run(bucket, 'aws')
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].fix).toContain('region')
  })

  it('continues past a 403 on HeadBucket, since the probe decides', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.failOp('HeadBucket', 403, 'AccessDenied')
    const outcome = await run(bucket)
    expect(outcome.ok).toBe(true)
    expect(byId(outcome.steps, 'bucket').status).toBe('warn')
  })
})

describe('bucket setup — the Filebase type check', () => {
  it('passes an S3-type bucket and leaves nothing behind', async () => {
    const bucket = createFakeBucket(BUCKET)
    const outcome = await run(bucket, 'filebase', FILEBASE)
    expect(outcome.ok).toBe(true)
    expect(byId(outcome.steps, 'bucket-type').status).toBe('ok')
    expect(bucket.keys()).toEqual([])
  })

  it('undoes a bucket it created that turned out to be IPFS', async () => {
    // The Filebase preset never creates, so drive the rollback path through
    // the generic preset pointed at a Filebase host.
    const bucket = createFakeBucket(BUCKET)
    bucket.setExists(false)
    bucket.ipfsMode(true)
    const outcome = await run(bucket, 'other', FILEBASE)
    expect(outcome.ok).toBe(false)
    const type = byId(outcome.steps, 'bucket-type')
    expect(type.status).toBe('fail')
    expect(type.detail).toContain('deleted again')
    expect(type.fix).toContain('choose S3, not IPFS')
    expect(bucket.exists()).toBe(false)
    expect(bucket.count('DeleteBucket')).toBe(1)
    expect(outcome.steps.map((s) => s.id)).toEqual(['bucket', 'bucket-type'])
  })

  it('leaves a pre-existing IPFS bucket alone and says so', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.ipfsMode(true)
    const outcome = await run(bucket, 'filebase', FILEBASE)
    expect(outcome.ok).toBe(false)
    expect(bucket.exists()).toBe(true)
    expect(bucket.count('DeleteBucket')).toBe(0)
    expect(byId(outcome.steps, 'bucket-type').detail).toContain('IPFS bucket')
  })

  it('runs on a Filebase host even under the generic preset', async () => {
    const bucket = createFakeBucket(BUCKET)
    const outcome = await run(bucket, 'other', FILEBASE)
    expect(byId(outcome.steps, 'bucket-type').status).toBe('ok')
  })

  it('skips rather than fails when the test write is refused', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.failOp('PutObject', 403, 'AccessDenied')
    const outcome = await run(bucket, 'filebase', FILEBASE)
    expect(byId(outcome.steps, 'bucket-type').status).toBe('skip')
    expect(byId(outcome.steps, 'probe').status).toBe('fail')
  })
})

describe('bucket setup — CORS and versioning', () => {
  it('names the token scope when R2 refuses the CORS change, and still probes', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.failOp('PutBucketCors', 403, 'AccessDenied')
    const outcome = await run(bucket, 'r2', config({ region: 'auto' }))
    expect(outcome.ok).toBe(false)
    expect(byId(outcome.steps, 'cors').fix).toContain('Admin Read & Write')
    expect(byId(outcome.steps, 'probe').status).toBe('ok')
  })

  it('sends the user to the console when CORS is not accepted over the API', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.notImplemented('PutBucketCors')
    const outcome = await run(bucket)
    expect(byId(outcome.steps, 'cors').status).toBe('fail')
    expect(byId(outcome.steps, 'cors').http).toEqual({
      status: 501,
      code: 'NotImplemented',
    })
  })

  it('warns, not fails, when the rule cannot be read back', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.notImplemented('GetBucketCors')
    const outcome = await run(bucket)
    expect(outcome.ok).toBe(true)
    expect(byId(outcome.steps, 'cors').status).toBe('warn')
    expect(byId(outcome.steps, 'cors').detail).toContain('Applied')
  })

  it('fails when what the bucket reports back does not cover the app', async () => {
    const bucket = createFakeBucket(BUCKET)
    const readOnly = async (url: string, init: RequestInit) => {
      if (url.includes('cors=') && init.method === 'GET') {
        return new Response(
          '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader></CORSRule></CORSConfiguration>',
          { status: 200 },
        )
      }
      return bucket.fetch(url, init)
    }
    const outcome = await runBucketSetup(
      { config: config(), providerId: 'other', origins: ['*'] },
      { fetchImpl: readOnly },
    )
    expect(byId(outcome.steps, 'cors').status).toBe('fail')
    expect(byId(outcome.steps, 'cors').detail).toContain('method PUT')
  })

  it('warns when versioning is on, without changing it', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.setVersioning('Enabled')
    const outcome = await run(bucket)
    expect(outcome.ok).toBe(true)
    const step = byId(outcome.steps, 'versioning')
    expect(step.status).toBe('warn')
    expect(step.fix).toContain('does not change it')
    expect(
      bucket.ops().filter((o) => o === 'GetBucketVersioning'),
    ).toHaveLength(1)
  })

  it('treats an unsupported versioning call as off', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.notImplemented('GetBucketVersioning')
    const outcome = await run(bucket)
    expect(byId(outcome.steps, 'versioning').status).toBe('ok')
    expect(byId(outcome.steps, 'versioning').detail).toContain('Not supported')
  })
})

describe('bucket setup — the probe', () => {
  it('reports the failed step and the fix', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.failOp('DeleteObject', 403, 'AccessDenied')
    const outcome = await run(bucket)
    expect(outcome.ok).toBe(false)
    const probe = byId(outcome.steps, 'probe')
    expect(probe.probe).toMatchObject({ failedStep: 'delete', kind: 'denied' })
    expect(probe.detail).toContain('not delete')
    expect(probe.fix).toContain('re-run the same command')
  })

  it('explains a region mismatch as a region, not as bad keys', async () => {
    const bucket = createFakeBucket(BUCKET)
    bucket.failOp('ListObjectsV2', 400, 'AuthorizationHeaderMalformed')
    const outcome = await run(bucket, 'garage', config({ region: 'us-east-1' }))
    expect(byId(outcome.steps, 'probe').detail).toContain('s3_region')
  })
})
