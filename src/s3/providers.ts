// The providers a form can be prefilled for, and the endpoint hazards worth
// stopping a user on. Nothing else under `s3/` names a vendor.
//
// Garage and SeaweedFS are the named self-hosted servers because both
// implement `ListObjectsV2` and the bucket CORS trio in their free, maintained
// build. MinIO's community edition was archived in February 2026 and had
// already moved per-bucket CORS to the paid product; an existing MinIO
// belongs under `other`.

/** Which vendor's defaults to prefill. `other` prefills nothing. */
export type S3ProviderId =
  'filebase' | 'r2' | 'aws' | 'garage' | 'seaweedfs' | 'other'

/** Whose machine the storage is on. */
export type S3ProviderCategory = 'hosted' | 'self-hosted' | 'other'

export interface S3Provider {
  id: S3ProviderId
  label: string
  category: S3ProviderCategory
  /** Fixed endpoint, or null when it is per-account and must be typed. */
  endpoint: string | null
  endpointPlaceholder: string
  region: string
  /** False when the vendor has exactly one signing region and typing another only breaks it. */
  regionEditable: boolean
  /**
   * True for everything except AWS: virtual-host style needs a wildcard
   * certificate and per-bucket DNS, which a self-hosted server behind a
   * single-name certificate does not have. AWS has the wildcard cert and
   * deprecates path-style.
   */
  forcePathStyle: boolean
  /** What the vendor's own dashboard calls the two halves of the key pair. */
  accessKeyLabel: string
  secretKeyLabel: string
  /**
   * `global`: the name is shared with every customer of the service, so an
   * obvious one is taken. `private`: the user's own account or server.
   */
  bucketNamespace: 'global' | 'private'
}

// Array order is on-screen order within each category, and `other` stays last
// because `providerById` falls back to the final element.
export const S3_PROVIDERS: readonly S3Provider[] = [
  {
    id: 'filebase',
    label: 'Filebase',
    category: 'hosted',
    endpoint: 'https://s3.filebase.io',
    endpointPlaceholder: 'https://s3.filebase.io',
    region: 'auto',
    regionEditable: false,
    forcePathStyle: true,
    accessKeyLabel: 'Access token',
    secretKeyLabel: 'Secret key',
    bucketNamespace: 'global',
  },
  {
    id: 'r2',
    label: 'Cloudflare R2',
    category: 'hosted',
    endpoint: null,
    endpointPlaceholder: 'https://<account-id>.r2.cloudflarestorage.com',
    region: 'auto',
    regionEditable: false,
    forcePathStyle: true,
    accessKeyLabel: 'Access key ID',
    secretKeyLabel: 'Secret access key',
    bucketNamespace: 'private',
  },
  {
    id: 'aws',
    label: 'Amazon S3',
    category: 'hosted',
    endpoint: null,
    endpointPlaceholder: 'https://s3.us-east-1.amazonaws.com',
    region: 'us-east-1',
    regionEditable: true,
    forcePathStyle: false,
    accessKeyLabel: 'Access key ID',
    secretKeyLabel: 'Secret access key',
    bucketNamespace: 'global',
  },
  {
    id: 'garage',
    label: 'Garage',
    category: 'self-hosted',
    endpoint: null,
    endpointPlaceholder: 'https://storage.example.com',
    // Garage signs against its own `s3_region`, and every published sample
    // sets `garage`. A wrong guess fails as `AuthorizationHeaderMalformed`,
    // which reads as a credential problem and is not one.
    region: 'garage',
    regionEditable: true,
    forcePathStyle: true,
    accessKeyLabel: 'Key ID',
    secretKeyLabel: 'Secret key',
    bucketNamespace: 'private',
  },
  {
    id: 'seaweedfs',
    label: 'SeaweedFS',
    category: 'self-hosted',
    endpoint: null,
    endpointPlaceholder: 'https://storage.example.com',
    // SeaweedFS signs against `us-east-1` unless its operator configured another.
    region: 'us-east-1',
    regionEditable: true,
    forcePathStyle: true,
    accessKeyLabel: 'Access key',
    secretKeyLabel: 'Secret key',
    bucketNamespace: 'private',
  },
  {
    id: 'other',
    label: 'Other S3-compatible',
    category: 'other',
    endpoint: null,
    endpointPlaceholder: 'https://s3.example.com',
    region: 'us-east-1',
    regionEditable: true,
    forcePathStyle: true,
    accessKeyLabel: 'Access key ID',
    secretKeyLabel: 'Secret access key',
    // Unknowable; `global` is the half of the guess that is merely unnecessary when wrong.
    bucketNamespace: 'global',
  },
]

/** The categories in on-screen order, each with the heading it renders under. */
export const S3_PROVIDER_CATEGORIES: readonly {
  id: S3ProviderCategory
  label: string
}[] = [
  { id: 'hosted', label: 'Someone hosts it' },
  { id: 'self-hosted', label: 'You host it' },
  { id: 'other', label: 'Something else' },
]

export function providersInCategory(
  category: S3ProviderCategory,
): S3Provider[] {
  return S3_PROVIDERS.filter((p) => p.category === category)
}

export function providerById(id: S3ProviderId): S3Provider {
  return (
    S3_PROVIDERS.find((p) => p.id === id) ??
    S3_PROVIDERS[S3_PROVIDERS.length - 1]
  )
}

/**
 * Loopback or private-network address? Decides whether to warn, nothing more.
 * The ranges are the ones browsers treat as "local network" for the
 * permission gate.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  )
    return true
  if (host === '[::1]' || host === '::1') return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  // 172.16.0.0 – 172.31.255.255; a regex would also match 172.3. and 172.320.
  const octets = host.split('.')
  if (octets.length === 4 && octets[0] === '172') {
    const second = Number(octets[1])
    if (Number.isInteger(second) && second >= 16 && second <= 31) return true
  }
  return false
}

/**
 * Things about this endpoint that may work in one browser and fail in the
 * next. Cautions, not errors. Ordered most-likely-to-bite first.
 */
export function endpointCautions(endpoint: string): string[] {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return []
  }
  const cautions: string[] = []

  if (url.protocol === 'http:') {
    cautions.push(
      isLocalHost(url.hostname)
        ? 'This is a plain http:// address on your own machine or network. Browsers allow that only after asking your permission, and some refuse outright — putting a TLS certificate in front of your storage is the configuration that works everywhere.'
        : 'This is a plain http:// address. A page served over https cannot make requests to it, so this will fail in every browser. Use https://.',
    )
  } else if (isLocalHost(url.hostname)) {
    cautions.push(
      'This address is on your own machine or local network. Browsers now ask permission before a website may reach one, and a phone on a different network will not reach it at all — give your storage a public hostname if you want your other devices to sync.',
    )
  }

  if (url.hostname === 's3.filebase.com') {
    cautions.push(
      'Filebase documents s3.filebase.io as its S3 endpoint. Use that host, and make sure the bucket itself is a standard S3 bucket rather than an IPFS one — objects in an IPFS bucket stay fetchable by CID from public gateways even when the bucket is private, and unpinning is not a guaranteed delete.',
    )
  }

  return cautions
}
