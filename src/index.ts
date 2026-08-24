/** DSH Host half: same-process realtime voice route, provider bridge, and complete disposal. */
import type { Duplex } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
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
export const inject = ['webServer', 'apiProxy', 'credentials', 'agents', 'systemPrompt', 'tools']

/** Mount one exact WebSocket route. Every accepted connection is owned by this plugin fiber. */
export function apply(ctx: Context, config: VoiceConfig): void {
  const proxyServer = new WebSocketServer({ noServer: true })
  const directServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const connections = new Set<{ dispose(reason?: string): void }>()
  const voiceRuntime = new VoiceRuntime()
  let readConfig = (): VoiceConfig => config

  // Settings are optional at the Cordis boundary. When the Web profile serves
  // them, model changes become authoritative for the next accepted call; an
  // already connected upstream keeps its negotiated model until that call ends.
  installSettingsSection(
    ctx,
    settingsNamespace(REALTIME_VOICE_SETTINGS_NAMESPACE),
    Config,
    config,
    {
      setSource(source) { readConfig = source },
      onChange() {},
    },
  )

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
