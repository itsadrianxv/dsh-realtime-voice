import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceCallController } from '../src/client/controller.ts'

describe('assistant realtime transcript', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('accumulates delta fragments, accepts the final transcript, and resets for the next response', async () => {
    const controller = new VoiceCallController(() => {})
    const receive = (controller as unknown as { receive(event: MessageEvent): void }).receive.bind(controller)
    let serverSeq = 0
    const message = (value: object) => receive({
      data: JSON.stringify({ ...value, serverSeq: ++serverSeq }),
    } as MessageEvent)

    message({ type: 'voice.state', phase: 'thinking' })
    message({ type: 'voice.transcript', role: 'assistant', final: false, text: '测试' })
    message({ type: 'voice.transcript', role: 'assistant', final: false, text: '成功' })
    expect(controller.getSnapshot().assistantTranscript).toBe('测试成功')

    message({ type: 'voice.transcript', role: 'assistant', final: true, text: '测试成功！' })
    expect(controller.getSnapshot().assistantTranscript).toBe('测试成功！')

    message({ type: 'voice.state', phase: 'listening' })
    message({ type: 'voice.state', phase: 'thinking' })
    expect(controller.getSnapshot().assistantTranscript).toBe('')
    await controller.dispose()
  })

  it('stops playback locally before sending a fast-VAD cancellation', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const controller = new VoiceCallController(() => {})
    const interruptPlayback = vi.fn()
    const send = vi.fn()
    const internal = controller as unknown as {
      snapshot: ReturnType<VoiceCallController['getSnapshot']>
      audio: { interruptPlayback(): void; close(): Promise<void> }
      socket: { readyState: number; send(value: string): void }
      handleLocalSpeechStart(): void
    }
    internal.snapshot = {
      ...controller.getSnapshot(),
      phase: 'speaking',
      turnDetection: 'server_vad',
    }
    internal.audio = { interruptPlayback, close: async () => {} }
    internal.socket = { readyState: 1, send }

    internal.handleLocalSpeechStart()

    expect(interruptPlayback).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: 'voice.cancel-response' }))
    expect(controller.getSnapshot().phase).toBe('listening')
    await controller.dispose()
  })

  it('surfaces and answers an authoritative DSH approval without turning it into a new prompt', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 })
    const controller = new VoiceCallController()
    const receive = (controller as unknown as { receive(event: MessageEvent): void }).receive.bind(controller)
    const send = vi.fn()
    ;(controller as unknown as { socket: { readyState: number; send(value: string): void } }).socket = {
      readyState: 1,
      send,
    }
    receive({ data: JSON.stringify({
      type: 'voice.approval',
      serverSeq: 1,
      sessionId: 'session-one',
      status: 'pending',
      approval: { approvalId: 'approval-one', toolName: 'exec_command', reason: '打印机访问' },
    }) } as MessageEvent)

    expect(controller.getSnapshot().pendingApproval?.approvalId).toBe('approval-one')
    controller.answerApproval('approval-one', 'allowed-once')
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: 'voice.approval-answer',
      approvalId: 'approval-one',
      outcome: 'allowed-once',
    }))
    await controller.dispose()
  })
})
