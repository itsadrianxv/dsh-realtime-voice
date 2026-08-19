/** DSH Host half: same-process realtime voice route, provider bridge, and complete disposal. */
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WebSocketServer } from 'ws'
import { VOICE_ROUTE } from './protocol.ts'
import { Config, type VoiceConfig } from './host/config.ts'
import { VoiceConnection } from './host/voice-connection.ts'

export { Config }
export type { VoiceConfig }

/** Host services required before the route can be mounted. */
export const inject = ['webServer', 'apiProxy', 'credentials']

/** Mount one exact WebSocket route. Every accepted connection is owned by this plugin fiber. */
export function apply(ctx: Context, config: VoiceConfig): void {
  const server = new WebSocketServer({ noServer: true })
  const connections = new Set<VoiceConnection>()

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!isLoopback(request.socket.remoteAddress) || !isAllowedOrigin(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (connections.size >= config.maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    server.handleUpgrade(request, socket, head, (websocket) => {
      let connection: VoiceConnection
      connection = new VoiceConnection(ctx, websocket, request, config, () => connections.delete(connection))
      connections.add(connection)
    })
  }

  ctx.effect(() => {
    const unregister = ctx.webServer.registerUpgrade({ path: VOICE_ROUTE, handler: upgrade })
    return async () => {
      unregister()
      for (const connection of [...connections]) connection.dispose()
      connections.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
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
