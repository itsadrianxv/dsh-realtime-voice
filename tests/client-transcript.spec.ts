import { describe, expect, it } from 'vitest'
import { VoiceCallController } from '../src/client/controller.ts'

describe('assistant realtime transcript', () => {
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
})
