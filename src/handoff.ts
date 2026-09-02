import { encodeConnectionString } from './s3/connection-string.ts'
import type { S3MirrorConfig } from './s3/client.ts'
import type { S3ProviderId } from './s3/providers.ts'

export interface Handoff {
  connectionString: string
  link: string
}

/**
 * `appUrl` must be the origin where the user's passkey lives: a link built
 * for a content-addressed or gateway origin sends the phone somewhere its
 * passkey does not exist.
 *
 * The string goes into the fragment UNescaped, unlike the client's
 * `connectionDeepLink`. Its alphabet (`zsmirror1:` plus base64url) needs no
 * escaping, and a percent-escape is a liability here: terminal and IDE
 * link openers run `encodeURI` on what they open, which turns `%3A` into
 * `%253A` and the page then rejects the string. The route's
 * `connectionStringFromFragment` reads both forms.
 */
export function composeHandoff(
  config: S3MirrorConfig,
  providerId: S3ProviderId,
  appUrl: string,
): Handoff {
  const connectionString = encodeConnectionString(config, providerId)
  return {
    connectionString,
    link: `${new URL(appUrl).origin}/sync#c=${connectionString}`,
  }
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** `zs-` plus eight random base32 characters: unlikely to collide on a shared namespace. */
export function suggestBucketName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `zs-${Array.from(bytes, (b) => BASE32[b % 32]).join('')}`
}
