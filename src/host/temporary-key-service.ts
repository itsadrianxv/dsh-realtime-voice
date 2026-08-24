export interface TemporaryKey {
  token: string
  /** Unix timestamp in seconds, matching the DashScope API. */
  expiresAt: number
}

export type TemporaryKeyFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Safe provider error that never contains either permanent or temporary credentials. */
export class TemporaryKeyIssueError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly providerCode?: string,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'TemporaryKeyIssueError'
  }
}

/** Server-side JIT issuer. The permanent API key never leaves this call. */
export class TemporaryKeyService {
  constructor(
    private readonly fetchImpl: TemporaryKeyFetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async issue(endpoint: string, permanentApiKey: string, ttlSeconds: number, timeoutMs: number): Promise<TemporaryKey> {
    if (permanentApiKey.trim() === '' || permanentApiKey.length > 4_096) {
      throw new TemporaryKeyIssueError('permanent credential is missing or malformed')
    }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 1800) {
      throw new TemporaryKeyIssueError('temporary key TTL must be between 1 and 1800 seconds')
    }
    const url = new URL(endpoint)
    const allowedHosts = new Set(['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'])
    if (url.protocol !== 'https:'
      || !allowedHosts.has(url.hostname)
      || url.pathname !== '/api/v1/tokens'
      || url.username !== ''
      || url.password !== ''
      || (url.port !== '' && url.port !== '443')) {
      throw new TemporaryKeyIssueError('temporary key endpoint must be an official DashScope token endpoint')
    }
    url.searchParams.set('expire_in_seconds', String(ttlSeconds))
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${permanentApiKey}` },
        redirect: 'error',
        signal: abort.signal,
      })
    } catch (error) {
      const detail = error instanceof Error && error.name === 'AbortError' ? 'request timed out' : 'network request failed'
      throw new TemporaryKeyIssueError(`DashScope temporary key ${detail}`)
    } finally {
      clearTimeout(timeout)
    }
    const payload = await readJsonObject(response)
    if (!response.ok) {
      const code = safeIdentifier(payload.code, permanentApiKey)
      const requestId = safeIdentifier(payload.request_id, permanentApiKey)
      throw new TemporaryKeyIssueError(
        `DashScope temporary key request failed${code === undefined ? '' : ` (${code})`}${requestId === undefined ? '' : ` [${requestId}]`}`,
        response.status,
        code,
        requestId,
      )
    }
    const token = payload.token
    const expiresAt = payload.expires_at
    if (typeof token !== 'string' || token.length < 4 || token.length > 512) {
      throw new TemporaryKeyIssueError('DashScope temporary key response omitted a valid token', response.status)
    }
    const nowSeconds = Math.floor(this.now() / 1000)
    if (typeof expiresAt !== 'number'
      || !Number.isSafeInteger(expiresAt)
      || expiresAt <= nowSeconds
      || expiresAt > nowSeconds + ttlSeconds + 120) {
      throw new TemporaryKeyIssueError('DashScope temporary key response has an invalid expiration', response.status)
    }
    return { token, expiresAt }
  }
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json()
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function safeIdentifier(value: unknown, permanentApiKey: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const safe = value.replaceAll(/[^a-zA-Z0-9._:-]/g, '').slice(0, 128)
  if (safe === '' || safe.includes(permanentApiKey) || /(?:sk|st)-[a-zA-Z0-9._-]+/i.test(safe)) return undefined
  return safe
}
