// The bucket-side steps, in order, each reported as a verdict the CLI can
// render and `--json` can emit.
//
// Every step is safe to repeat, which is what makes "fix that, then re-run
// the same command" honest: `HeadBucket` finds a bucket a previous run
// created, `PutBucketCors` overwrites, the type check and the probe delete
// what they wrote, and nothing depends on a previous run's side effects.
// The only irreversible action is `CreateBucket`, and it happens at most
// once per bucket name.

import { S3Client, type FetchLike, type S3MirrorConfig } from './s3/client.ts'
import { MirrorIOError } from './s3/errors.ts'
import type { S3ProviderId } from './s3/providers.ts'
import {
  probeSegments,
  randomNonce,
  testS3Connection,
  type S3ConnectionTest,
} from './s3/setup.ts'
import { textOf } from './s3/xml.ts'
import {
  corsConfigurationXml,
  corsCovers,
  parseCorsConfiguration,
} from './cors.ts'
import { notesFor, type ProviderNotes } from './provider-notes.ts'
import {
  httpFacts,
  httpLabel,
  probeFailure,
  RERUN,
  signingProblem,
  unreachable,
  type HttpFacts,
} from './report.ts'

export type StepId = 'bucket' | 'bucket-type' | 'cors' | 'versioning' | 'probe'
export type StepStatus = 'ok' | 'warn' | 'fail' | 'skip'

export interface StepResult {
  id: StepId
  status: StepStatus
  /** One line: what happened. */
  detail: string
  /** What to change. Present on `fail`, sometimes on `warn`. */
  fix?: string
  /** What the wire said, when an HTTP answer was involved. */
  http?: HttpFacts
  /** The four-step probe, on the `probe` step only. */
  probe?: S3ConnectionTest
}

export const STEP_TITLES: Record<StepId, string> = {
  bucket: 'Bucket',
  'bucket-type': 'Bucket type',
  cors: 'CORS rule',
  versioning: 'Versioning',
  probe: 'Connection probe',
}

export interface SetupInput {
  config: S3MirrorConfig
  providerId: S3ProviderId
  /** CORS `AllowedOrigins`. */
  origins: readonly string[]
}

export interface SetupDeps {
  fetchImpl?: FetchLike
  now?: () => Date
  /** Called as each step completes, for progressive rendering. */
  onStep?: (step: StepResult) => void
}

export interface SetupOutcome {
  /** No step failed. Warnings do not count. */
  ok: boolean
  steps: StepResult[]
}

function isFilebaseHost(endpoint: string): boolean {
  try {
    return /(^|\.)filebase\.(io|com)$/i.test(new URL(endpoint).hostname)
  } catch {
    return false
  }
}

export async function runBucketSetup(
  input: SetupInput,
  deps: SetupDeps = {},
): Promise<SetupOutcome> {
  const { config, providerId, origins } = input
  const client = new S3Client(config, deps.fetchImpl, deps.now)
  const notes = notesFor(providerId)
  const steps: StepResult[] = []
  const report = (step: StepResult) => {
    steps.push(step)
    deps.onStep?.(step)
    return step
  }

  const bucket = await ensureBucket(client, notes)
  report(bucket.step)
  if (bucket.step.status === 'fail') {
    return { ok: false, steps }
  }

  if (notes.bucketTypeCheck || isFilebaseHost(config.endpoint)) {
    const type = report(await checkBucketType(client, notes, bucket.created))
    if (type.status === 'fail') return { ok: false, steps }
  } else {
    report({
      id: 'bucket-type',
      status: 'skip',
      detail: 'Only Filebase has bucket types.',
    })
  }

  report(await applyCors(client, notes, origins))
  report(await checkVersioning(client))
  report(await runProbe(client, config, providerId))

  return { ok: steps.every((s) => s.status !== 'fail'), steps }
}

async function ensureBucket(
  client: S3Client,
  notes: ProviderNotes,
): Promise<{ step: StepResult; created: boolean }> {
  const { bucket, endpoint } = client.config
  const at = `${bucket} at ${endpoint}`
  let status: number
  try {
    status = await client.headBucket()
  } catch (err) {
    return {
      created: false,
      step: {
        id: 'bucket',
        status: 'fail',
        detail: unreachable(endpoint, err),
        fix: RERUN,
        http: httpFacts(err),
      },
    }
  }

  if (status === 200) {
    return {
      created: false,
      step: { id: 'bucket', status: 'ok', detail: `Bucket exists: ${at}.` },
    }
  }

  if (status === 404) {
    if (notes.createMissing === 'console-only') {
      return {
        created: false,
        step: {
          id: 'bucket',
          status: 'fail',
          detail: `No bucket named ${at}.`,
          fix: `Create an S3-type bucket named ${bucket} at ${notes.bucketsAt}, then re-run the same command.`,
          http: { status },
        },
      }
    }
    try {
      await client.createBucket()
      return {
        created: true,
        step: { id: 'bucket', status: 'ok', detail: `Created bucket ${at}.` },
      }
    } catch (err) {
      const http = httpFacts(err)
      if (http?.code === 'BucketAlreadyOwnedByYou') {
        return {
          created: false,
          step: {
            id: 'bucket',
            status: 'ok',
            detail: `Bucket exists: ${at}.`,
            http,
          },
        }
      }
      if (http?.code === 'NoSuchBucket') {
        // Observed on s3.filebase.com: the host does not serve this bucket
        // namespace at all, so even a create answers "no such bucket".
        return {
          created: false,
          step: {
            id: 'bucket',
            status: 'fail',
            detail: `The endpoint answered NoSuchBucket to a create${httpLabel(http)}, so it does not host buckets under this name at all.`,
            fix: isFilebaseHost(endpoint)
              ? 'S3-type Filebase buckets live on https://s3.filebase.io; use that endpoint, then re-run the same command.'
              : `Check the endpoint host: it should be the S3 API of the account that owns the bucket. ${RERUN}`,
            http,
          },
        }
      }
      if (http?.code === 'BucketAlreadyExists') {
        return {
          created: false,
          step: {
            id: 'bucket',
            status: 'fail',
            detail: `The name ${bucket} is taken by another customer of this service${httpLabel(http)}.`,
            fix: 'Pick another name (the suggested zs-… names are random for this reason), then re-run.',
            http,
          },
        }
      }
      const known = signingProblem(
        http?.code,
        client.config.region === 'auto' ? 'r2' : 'other',
      )
      if (err instanceof MirrorIOError && err.kind === 'denied') {
        return {
          created: false,
          step: {
            id: 'bucket',
            status: 'fail',
            detail: `Could not create ${at}${httpLabel(http)}.`,
            fix: `${notes.createForbidden}`,
            http,
          },
        }
      }
      return {
        created: false,
        step: {
          id: 'bucket',
          status: 'fail',
          detail: `Could not create ${at}${httpLabel(http)}.`,
          fix: known ? `${known} ${RERUN}` : RERUN,
          http,
        },
      }
    }
  }

  if (status === 301 || status === 307) {
    return {
      created: false,
      step: {
        id: 'bucket',
        status: 'fail',
        detail: `The endpoint redirected (HTTP ${status}): the bucket lives in a different region from the one the endpoint names.`,
        fix: `${notes.regionHint} ${RERUN}`,
        http: { status },
      },
    }
  }

  if (status === 403) {
    return {
      created: false,
      step: {
        id: 'bucket',
        status: 'warn',
        detail:
          'The endpoint would not say whether the bucket exists (HTTP 403 on HeadBucket). Continuing; the probe below is the real test.',
        http: { status },
      },
    }
  }

  return {
    created: false,
    step: {
      id: 'bucket',
      status: 'fail',
      detail: `HeadBucket answered HTTP ${status}, which for most services means the region does not match the bucket’s.`,
      fix: `${notes.regionHint} ${RERUN}`,
      http: { status },
    },
  }
}

async function checkBucketType(
  client: S3Client,
  notes: ProviderNotes,
  created: boolean,
): Promise<StepResult> {
  const segments = probeSegments(randomNonce())
  let headers: Headers
  try {
    headers = await client.putObjectWithHeaders(
      segments,
      crypto.getRandomValues(new Uint8Array(16)),
    )
  } catch (err) {
    return {
      id: 'bucket-type',
      status: 'skip',
      detail: `Could not write a test object to check the bucket type${httpLabel(httpFacts(err))}; the probe below will say why.`,
      http: httpFacts(err),
    }
  }
  try {
    await client.deleteObject(segments)
  } catch {
    // The probe reports a delete that fails; a second report here would be noise.
  }

  const cid = headers.get('x-amz-meta-cid')
  if (!cid) {
    return {
      id: 'bucket-type',
      status: 'ok',
      detail: 'S3-type bucket (no IPFS content id on a test write).',
    }
  }

  let undone = false
  if (created) {
    try {
      await client.deleteBucket()
      undone = true
    } catch {
      undone = false
    }
  }
  const what = created
    ? undone
      ? 'Filebase created it as an IPFS bucket through the API, so it has been deleted again.'
      : 'Filebase created it as an IPFS bucket through the API, and it could not be deleted again — remove it in the console.'
    : 'This is an IPFS bucket.'
  return {
    id: 'bucket-type',
    status: 'fail',
    detail: `${what} Objects in an IPFS bucket are fetchable by content id from public gateways even when the bucket is private, and unpinning is not a guaranteed delete.`,
    fix: `Create an S3-type bucket named ${client.config.bucket} at ${notes.bucketsAt} (choose S3, not IPFS), then re-run the same command.`,
  }
}

async function applyCors(
  client: S3Client,
  notes: ProviderNotes,
  origins: readonly string[],
): Promise<StepResult> {
  const from = origins.includes('*') ? 'any origin' : origins.join(', ')
  try {
    await client.putBucketCors(corsConfigurationXml(origins))
  } catch (err) {
    const http = httpFacts(err)
    if (err instanceof MirrorIOError && err.kind === 'denied') {
      return {
        id: 'cors',
        status: 'fail',
        detail: `Could not apply the CORS rule${httpLabel(http)}.`,
        fix: notes.corsForbidden,
        http,
      }
    }
    if (
      http?.status === 501 ||
      http?.status === 405 ||
      http?.code === 'NotImplemented'
    ) {
      return {
        id: 'cors',
        status: 'fail',
        detail: `This service does not accept CORS rules over the S3 API${httpLabel(http)}.`,
        fix: `Apply the rule with ${notes.bucketsAt}, then re-run the same command.`,
        http,
      }
    }
    const known = signingProblem(http?.code, 'other')
    return {
      id: 'cors',
      status: 'fail',
      detail: `Could not apply the CORS rule${httpLabel(http)}.`,
      fix: known ? `${known} ${RERUN}` : RERUN,
      http,
    }
  }

  let readBack: string | null
  try {
    readBack = await client.getBucketCors()
  } catch (err) {
    const http = httpFacts(err)
    return {
      id: 'cors',
      status: 'warn',
      detail: `Applied (GET, PUT, DELETE, HEAD from ${from}), but the bucket would not report it back${httpLabel(http)}.`,
      http,
    }
  }
  if (readBack === null) {
    return {
      id: 'cors',
      status: 'warn',
      detail: `Applied, but reading it back found no rule on the bucket. Some services take a moment; if the app reports a CORS refusal, re-run.`,
    }
  }
  let coverage
  try {
    coverage = corsCovers(parseCorsConfiguration(readBack), origins)
  } catch {
    return {
      id: 'cors',
      status: 'warn',
      detail: 'Applied, but the rule read back could not be parsed.',
    }
  }
  if (coverage.ok) {
    return {
      id: 'cors',
      status: 'ok',
      detail: `Applied and read back: GET, PUT, DELETE, HEAD from ${from}, ETag exposed.`,
    }
  }
  return {
    id: 'cors',
    status: 'fail',
    detail: `Applied, but the rule the bucket reports back is missing ${coverage.missing.join(', ')}.`,
    fix: `Apply the rule with ${notes.bucketsAt} instead, then re-run the same command.`,
  }
}

async function checkVersioning(client: S3Client): Promise<StepResult> {
  let xml: string
  try {
    xml = await client.getBucketVersioning()
  } catch (err) {
    const http = httpFacts(err)
    if (
      http?.status === 501 ||
      http?.status === 405 ||
      http?.status === 400 ||
      http?.code === 'NotImplemented'
    ) {
      return {
        id: 'versioning',
        status: 'ok',
        detail: `Not supported by this service${httpLabel(http)}, so it cannot be on.`,
        http,
      }
    }
    return {
      id: 'versioning',
      status: 'warn',
      detail: `Could not check${httpLabel(http)}. Make sure versioning is off in the console: a version history quietly keeps every chat you delete.`,
      http,
    }
  }
  const status = textOf(xml, 'Status')
  if (status === '') {
    return { id: 'versioning', status: 'ok', detail: 'Off.' }
  }
  return {
    id: 'versioning',
    status: 'warn',
    detail:
      status === 'Enabled'
        ? 'Versioning is ON. Deleting a chat would leave the old copy in the bucket’s version history.'
        : `Versioning is ${status}: versions already stored are kept.`,
    fix: 'Turn versioning off in the console and delete any retained versions. This tool does not change it.',
  }
}

async function runProbe(
  client: S3Client,
  config: S3MirrorConfig,
  providerId: S3ProviderId,
): Promise<StepResult> {
  const fetchImpl: FetchLike = (url, init) => client['fetchImpl'](url, init)
  const test = await testS3Connection(config, fetchImpl)
  if (test.ok) {
    return {
      id: 'probe',
      status: 'ok',
      detail: probeFailure(test, providerId, config.endpoint),
      probe: test,
    }
  }
  return {
    id: 'probe',
    status: 'fail',
    detail: probeFailure(test, providerId, config.endpoint),
    fix: RERUN,
    http: { status: test.status, code: test.sourceName },
    probe: test,
  }
}
