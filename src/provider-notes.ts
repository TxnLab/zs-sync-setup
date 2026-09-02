// What this tool knows about each provider beyond the client's preset table:
// where keys come from, and what to do when a bucket is missing or cannot be
// created.

import type { S3ProviderId } from './s3/providers.ts'

/**
 * What to do when `HeadBucket` says the bucket is not there.
 *
 * `console-only` exists for Filebase, where a bucket created through the S3
 * API may land on the IPFS network with no way to choose otherwise. Flip it
 * per the live findings; the type check runs either way.
 */
export type CreateMissingPolicy = 'create-then-verify' | 'console-only'

export interface ProviderNotes {
  /** Where the user makes keys. A URL for hosted providers, a command for self-hosted. */
  keysAt: string
  /** Where the user makes buckets, when creation has to happen there. */
  bucketsAt: string
  createMissing: CreateMissingPolicy
  /** Why `CreateBucket` was refused, in terms of what the user can change. */
  createForbidden: string
  /** Why `PutBucketCors` was refused. */
  corsForbidden: string
  /** What the region field must hold, for the signature failure that reads as bad keys. */
  regionHint: string
  /** Whether a bucket can be an IPFS bucket, which the tool must detect. */
  bucketTypeCheck: boolean
}

export const PROVIDER_NOTES: Record<S3ProviderId, ProviderNotes> = {
  filebase: {
    keysAt: 'https://console.filebase.com/keys',
    bucketsAt: 'https://console.filebase.com/buckets',
    createMissing: 'create-then-verify',
    createForbidden:
      'Filebase refused to create the bucket with this key. Create it in the console (choose the S3 bucket type, not IPFS) and re-run.',
    corsForbidden:
      'Filebase refused the CORS change with this key. On the bucket’s CORS tab in the console, set Configuration to Public Read-Write, then re-run.',
    regionHint: 'For Filebase the region must stay `auto`.',
    bucketTypeCheck: true,
  },
  r2: {
    keysAt: 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens',
    bucketsAt: 'https://dash.cloudflare.com/?to=/:account/r2/overview',
    createMissing: 'create-then-verify',
    createForbidden:
      'R2 refused to create the bucket. This token is probably scoped to Object Read & Write; creating buckets needs Admin Read & Write. Either use an admin token for this one run, or create the bucket in the dashboard and re-run.',
    corsForbidden:
      'R2 refused the CORS change. Object-level tokens cannot edit bucket settings; use an Admin Read & Write token for this run, or paste the rule on the bucket’s Settings tab and re-run.',
    regionHint: 'For R2 the region must stay `auto`.',
    bucketTypeCheck: false,
  },
  aws: {
    keysAt: 'https://console.aws.amazon.com/iam/home#/users',
    bucketsAt: 'https://s3.console.aws.amazon.com/s3/buckets',
    createMissing: 'create-then-verify',
    createForbidden:
      'AWS refused to create the bucket. The IAM user needs s3:CreateBucket, or create the bucket in the console (Block Public Access on) and re-run.',
    corsForbidden:
      'AWS refused the CORS change. The IAM user needs s3:PutBucketCORS on this bucket, or paste the rule under Permissions → Cross-origin resource sharing and re-run.',
    regionHint:
      'For AWS the region must be the bucket’s own region and match the endpoint host (https://s3.<region>.amazonaws.com).',
    bucketTypeCheck: false,
  },
  garage: {
    keysAt: 'garage key create <name>   (prints Key ID and Secret key)',
    bucketsAt:
      'garage bucket create <name> && garage bucket allow --read --write <name> --key <key>',
    createMissing: 'create-then-verify',
    createForbidden:
      'Garage refused to create the bucket with this key. Either `garage key allow --create-bucket <key>`, or create it on the server: garage bucket create <name>; garage bucket allow --read --write <name> --key <key>. Then re-run.',
    corsForbidden:
      'Garage refused the CORS change: the key needs owner permission on the bucket (`garage bucket allow --owner <name> --key <key>`), then re-run.',
    regionHint:
      'For Garage the region must equal `s3_region` in garage.toml (published samples use `garage`).',
    bucketTypeCheck: false,
  },
  seaweedfs: {
    keysAt:
      'weed shell → s3.configure -user=<name> -access_key=… -secret_key=… -buckets=<name> -actions=Read,Write,List,Tagging -apply',
    bucketsAt: 'aws s3 mb s3://<name> --endpoint-url <endpoint>',
    createMissing: 'create-then-verify',
    createForbidden:
      'SeaweedFS refused to create the bucket with this identity. Widen its -actions (or create the bucket with an admin identity), then re-run.',
    corsForbidden:
      'SeaweedFS refused the CORS change with this identity. Widen its -actions, or apply the rule with an admin identity, then re-run.',
    regionHint:
      'For SeaweedFS the region is `us-east-1` unless the operator configured another.',
    bucketTypeCheck: false,
  },
  other: {
    keysAt: 'your provider’s console or CLI',
    bucketsAt: 'your provider’s console or CLI',
    createMissing: 'create-then-verify',
    createForbidden:
      'The service refused to create the bucket with this key. Create it with whatever your provider offers, then re-run.',
    corsForbidden:
      'The service refused the CORS change with this key. Apply the rule with your provider’s console or CLI, then re-run.',
    regionHint:
      'The region must be whatever this server signs against; `us-east-1` is the common default.',
    bucketTypeCheck: false,
  },
}

export function notesFor(providerId: S3ProviderId): ProviderNotes {
  return PROVIDER_NOTES[providerId]
}
