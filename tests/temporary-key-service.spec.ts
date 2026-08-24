import { describe, expect, it, vi } from 'vitest'
import { TemporaryKeyIssueError, TemporaryKeyService } from '../src/host/temporary-key-service.ts'

describe('DashScope temporary key issuer', () => {
  it('keeps the permanent key server-side and requests the shortest configured TTL', async () => {
    const permanent = 'sk-permanent-never-log'
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('expire_in_seconds')).toBe('60')
      expect(url.toString()).not.toContain(permanent)
      expect(init).toMatchObject({ method: 'POST' })
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${permanent}`)
      expect(init).not.toHaveProperty('body')
      return new Response(JSON.stringify({ token: 'st-temporary', expires_at: 1_060 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const service = new TemporaryKeyService(fetcher, () => 1_000_000)
    await expect(service.issue('https://dashscope.aliyuncs.com/api/v1/tokens', permanent, 60, 1_000))
      .resolves.toEqual({ token: 'st-temporary', expiresAt: 1_060 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('redacts provider bodies and credentials from errors', async () => {
    const secret = 'sk-permanent-secret'
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: `InvalidApiKey-${secret}`,
      request_id: 'request-123',
      message: `do not expose ${secret} or st-temporary-secret`,
    }), { status: 401, headers: { 'content-type': 'application/json' } }))
    const service = new TemporaryKeyService(fetcher)
    const error = await service.issue('https://dashscope.aliyuncs.com/api/v1/tokens', secret, 60, 1_000)
      .catch(value => value)
    expect(error).toBeInstanceOf(TemporaryKeyIssueError)
    expect(String(error)).not.toContain(secret)
    expect(String(error)).not.toContain('st-temporary-secret')
  })

  it.each([0, 1801])('rejects an out-of-range TTL (%s) without making a request', async (ttl) => {
    const fetcher = vi.fn()
    await expect(new TemporaryKeyService(fetcher).issue('https://example.invalid/tokens', 'secret', ttl, 1_000))
      .rejects.toThrow(/between 1 and 1800/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects a provider response that silently widens the requested lifetime', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      token: 'st-too-long', expires_at: 10_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(new TemporaryKeyService(fetcher, () => 1_000_000)
      .issue('https://dashscope.aliyuncs.com/api/v1/tokens', 'permanent', 60, 1_000))
      .rejects.toThrow(/invalid expiration/)
  })

  it('refuses to send a permanent key to a configurable non-DashScope HTTPS endpoint', async () => {
    const fetcher = vi.fn()
    await expect(new TemporaryKeyService(fetcher)
      .issue('https://attacker.example/api/v1/tokens', 'permanent', 60, 1_000))
      .rejects.toThrow(/official DashScope/)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
