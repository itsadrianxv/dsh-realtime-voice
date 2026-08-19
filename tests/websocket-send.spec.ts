import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { isWebSocketSendError } from '../src/host/websocket-send.ts'

const servers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('browser WebSocket audio sends', () => {
  it('accepts the null success value emitted by ws', async () => {
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP WebSocket address')

    const accepted = once(server, 'connection')
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
    await once(client, 'open')
    const [socket] = await accepted as [WebSocket]

    const callbackValue = await new Promise<Error | null | undefined>(resolve => {
      socket.send(new ArrayBuffer(19_200), { binary: true }, resolve)
    })

    expect(callbackValue).toBeNull()
    expect(isWebSocketSendError(callbackValue)).toBe(false)
    expect(isWebSocketSendError(new Error('send failed'))).toBe(true)
    client.close()
    await once(client, 'close')
  })
})
