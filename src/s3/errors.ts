// The error vocabulary shared with the ZeroSignal client's mirror backends.
// Copied from the client's `backend.ts`; only `status` is new here.

export type MirrorErrorKind =
  /** No such object or bucket. */
  | 'not-found'
  /** Credentials rejected, or not allowed to do this. */
  | 'denied'
  /** Rate limited or briefly unavailable; retry later. */
  | 'locked'
  /** Out of space. */
  | 'quota'
  /**
   * The request never got an HTTP answer. In a browser this is what a CORS
   * refusal looks like; from Node it is DNS, TLS, or the network.
   */
  | 'blocked'
  /** Signed-request clock drift. Distinct from `denied`: the fix is the clock. */
  | 'skew'
  /** Retryable, cause unknown. */
  | 'transient'
  | 'other'

export class MirrorIOError extends Error {
  readonly kind: MirrorErrorKind
  /** The provider's error code or the underlying error's name. Never a message. */
  readonly sourceName: string
  /** The HTTP status, when there was one. */
  readonly status?: number

  constructor(
    kind: MirrorErrorKind,
    sourceName: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(`mirror io: ${kind} (${sourceName})`, { cause: options?.cause })
    this.name = 'MirrorIOError'
    this.kind = kind
    this.sourceName = sourceName
    this.status = options?.status
  }
}

export function isMirrorErrorKind(
  err: unknown,
  kind: MirrorErrorKind,
): boolean {
  return err instanceof MirrorIOError && err.kind === kind
}
