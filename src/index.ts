/** DSH Host half: same-process realtime voice route, provider bridge, and complete disposal. */
import type { Duplex } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { WebSocketServer } from 'ws'
import { VOICE_DIRECT_PROTOCOL, VOICE_ROUTE, VOICE_STATUS_ROUTE } from './protocol.ts'
import { VOICE_DIRECT_ROUTE, VOICE_DIRECT_STATUS_ROUTE } from './direct-protocol.ts'
import { Config, type VoiceConfig } from './host/config.ts'
import { VoiceConnection } from './host/voice-connection.ts'
import { VoiceRuntime } from './host/voice-runtime.ts'
import { DirectControlConnection } from './host/direct-control-connection.ts'
import { REALTIME_VOICE_SETTINGS_NAMESPACE } from './models.ts'

export { Config }
export type { VoiceConfig }

/** Host services required before the route can be mounted. */
export const inject = ['webServer', 'sessionController', 'credentials', 'agents', 'systemPrompt', 'tools']

/** Mount one exact WebSocket route. Every accepted connection is owned by this plugin fiber. */
export function apply(ctx: Context, config: VoiceConfig): void {
  // Harness 0.1.2 replaced the legacy ApiProxy service with the direct
  // SessionController/Typert services. Keep the plugin's internal call sites
  // stable behind a small local facade while the transport remains unchanged.
  ctx.inject(['sessionController'], (sessionCtx) => {
    const controller = (sessionCtx as Context & { sessionController: any }).sessionController
    const responders = new Map<string, (value: unknown) => void>()
    const ok = (value: unknown) => ({ result: { ok: true, value } })
    const apiProxy = {
      sessions: {
        list: async ({ payload }: { payload: Record<string, unknown> }) => ok(await controller.list(payload as never)),
        prompt: async ({ payload }: { payload: Record<string, unknown> }) => ok(await controller.prompt(payload as never, new AbortController().signal)),
        updateQueue: async ({ payload }: { payload: Record<string, unknown> }) => ok(controller.updateQueue(payload as never)),
        cancel: async ({ payload }: { payload: Record<string, unknown> }) => ok(controller.cancel(payload as never)),
        history: async ({ payload }: { payload: Record<string, unknown> }) => ok({ events: (await controller.page({ sessionId: payload.sessionId, limit: payload.maxMessages } as never, new AbortController().signal)).events }),
      },
      events: {
        host: (_request: unknown, signal: AbortSignal) => createLegacyEventStream(sessionCtx, 'host', signal),
        mux: (_request: unknown, signal: AbortSignal) => createLegacyEventStream(sessionCtx, 'mux', signal, responders),
      },
      respond: async ({ rpcId, result }: { rpcId: string; result?: { value?: unknown } }) => {
        const resolve = responders.get(String(rpcId))
        if (resolve === undefined) return { accepted: false, reason: 'response is no longer pending' }
        responders.delete(String(rpcId))
        resolve(result?.value)
        return { accepted: true }
      },
    }
    ctx.provide('apiProxy', apiProxy as never)
  })
  const proxyServer = new WebSocketServer({ noServer: true })
  const directServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const connections = new Set<{ dispose(reason?: string): void }>()
  const voiceRuntime = new VoiceRuntime()
  let readConfig = (): VoiceConfig => config

  // Settings are optional at the Cordis boundary. When the Web profile serves
  // them, model changes become authoritative for the next accepted call; an
  // already connected upstream keeps its negotiated model until that call ends.
  // `installSettingsSection` was removed in dsh-settings 0.1.2. Register the
  // namespace directly while keeping settings optional for non-Web profiles.
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(
      REALTIME_VOICE_SETTINGS_NAMESPACE,
      Config,
      { base: config },
    )
    readConfig = () => scope.get()
    settingsCtx.effect(() => () => {
      readConfig = () => config
    })
  })

  const authorizeUpgrade = (request: IncomingMessage, socket: Duplex): VoiceConfig | undefined => {
    const activeConfig = readConfig()
    if (!isLoopback(request.socket.remoteAddress) || !isAllowedOrigin(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return undefined
    }
    if (connections.size >= activeConfig.maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return undefined
    }
    return activeConfig
  }

  const upgradeProxy = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const activeConfig = authorizeUpgrade(request, socket)
    if (activeConfig === undefined) return
    proxyServer.handleUpgrade(request, socket, head, (websocket) => {
      let connection: VoiceConnection
      connection = new VoiceConnection(ctx, websocket, request, activeConfig, () => connections.delete(connection), voiceRuntime)
      connections.add(connection)
    })
  }

  const upgradeDirect = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const activeConfig = authorizeUpgrade(request, socket)
    if (activeConfig === undefined) return
    directServer.handleUpgrade(request, socket, head, (websocket) => {
      let connection: DirectControlConnection
      connection = new DirectControlConnection(ctx, websocket, request, activeConfig, () => connections.delete(connection), voiceRuntime)
      connections.add(connection)
    })
  }

  const status = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' })
      response.end()
      return
    }
    if (!isLoopback(request.socket.remoteAddress) || !isAllowedOrigin(request)) {
      response.writeHead(403)
      response.end()
      return
    }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    response.end(JSON.stringify(voiceRuntime.occupancy(
      request.url?.startsWith(VOICE_DIRECT_STATUS_ROUTE) === true ? VOICE_DIRECT_PROTOCOL : undefined,
    )))
  }

  ctx.effect(() => {
    const unregisterStatus = ctx.webServer.register({ kind: 'exact', path: VOICE_STATUS_ROUTE, handler: status })
    const unregisterDirectStatus = ctx.webServer.register({ kind: 'exact', path: VOICE_DIRECT_STATUS_ROUTE, handler: status })
    const unregister = ctx.webServer.registerUpgrade({ path: VOICE_ROUTE, handler: upgradeProxy })
    const unregisterDirect = ctx.webServer.registerUpgrade({ path: VOICE_DIRECT_ROUTE, handler: upgradeDirect })
    return async () => {
      unregisterDirect()
      unregister()
      unregisterDirectStatus()
      unregisterStatus()
      for (const connection of [...connections]) connection.dispose()
      connections.clear()
      voiceRuntime.clear()
      await Promise.all([
        new Promise<void>((resolve) => proxyServer.close(() => resolve())),
        new Promise<void>((resolve) => directServer.close(() => resolve())),
      ])
    }
  }, 'realtime-voice: route and active call lifecycle')
}
function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isAllowedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

function createLegacyEventStream(
  ctx: Context,
  kind: 'host' | 'mux',
  signal: AbortSignal,
  responders = new Map<string, (value: unknown) => void>(),
): AsyncIterable<{ rpcId: string; payload: unknown }> {
  const queue: Array<{ rpcId: string; payload: unknown }> = []
  let wake: (() => void) | undefined
  let closed = false
  const push = (payload: unknown) => {
    if (closed) return
    queue.push({ rpcId: randomUUID(), payload })
    wake?.()
  }
  const disposers = kind === 'host'
    ? [
        (ctx as any).on('api-session/status', (sessionId: unknown, running: unknown) => push({ type: 'host/session-status', sessionId, running })),
        (ctx as any).on('agent/error', (value: unknown) => {
          const event = value as Record<string, unknown>
          const agent = event.agent as Record<string, unknown> | undefined
          push({ type: 'host/agent-error', sessionId: agent?.id, error: event.error })
        }),
      ]
    : [
        (ctx as any).on('session/event', (session: unknown, event: unknown) => {
          const value = session as Record<string, unknown>
          push({ type: 'session/event', sessionId: value?.id ?? value?.sessionId, event })
        }),
        (ctx as any).on('approval/request', (request: any) => {
          const rpcId = randomUUID()
          push({ type: 'approval/requested', sessionId: request.agent?.session?.id ?? request.agent?.id, ...request, rpcId })
          return new Promise(resolve => responders.set(rpcId, resolve))
        }),
        (ctx as any).on('user-questions/request', (request: any) => {
          const rpcId = randomUUID()
          push({ type: 'question/requested', sessionId: request.agent?.session?.id ?? request.agent?.id, questions: request.questions, rpcId })
          return new Promise(resolve => responders.set(rpcId, resolve))
        }),
      ]
  const iterable = (async function* () {
    const abort = () => { closed = true; wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!closed && !signal.aborted) {
        if (queue.length > 0) {
          yield queue.shift() as { rpcId: string; payload: unknown }
          continue
        }
        await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
      }
    } finally {
      closed = true
      signal.removeEventListener('abort', abort)
      for (const dispose of disposers) dispose()
    }
  })()
  return iterable
}
