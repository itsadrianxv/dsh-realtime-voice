import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DshVoiceTools } from '../src/host/dsh-tools.ts'

const sessionId = 'session-test'

function ok(value: unknown = {}) {
  return { result: { ok: true as const, value } }
}

function createContext(running = false) {
  const sessions = {
    list: vi.fn(async () => ok({
      items: [{ sessionId, running, blank: false, cwd: 'E:\\project' }],
    })),
    history: vi.fn(async () => ok({
      events: [{
        event: {
          type: 'assistant/message',
          message: { content: [{ type: 'text', text: 'latest result' }] },
        },
      }],
    })),
    prompt: vi.fn(async () => ok()),
    cancel: vi.fn(async () => ok()),
  }
  return { context: { apiProxy: { sessions } } as never, sessions }
}

describe('DSH voice tool boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads authoritative session state and recent assistant text', async () => {
    const { context } = createContext(true)
    const tools = new DshVoiceTools(context, sessionId)
    await expect(tools.status()).resolves.toEqual({
      sessionId,
      running: true,
      blank: false,
      cwd: 'E:\\project',
      summary: 'latest result',
    })
  })

  it('maps automatic follow-ups to steer while the Agent is running', async () => {
    const { context, sessions } = createContext(true)
    const tools = new DshVoiceTools(context, sessionId)
    const result = await tools.execute({
      callId: 'call-steer',
      name: 'send_task_message',
      arguments: JSON.stringify({ instruction: 'change direction', mode: 'auto' }),
    })
    expect(result.ok).toBe(true)
    expect(sessions.prompt).toHaveBeenCalledTimes(1)
    expect(sessions.prompt.mock.calls[0]?.[0].payload).toMatchObject({
      sessionId,
      mode: 'steer',
      content: [{ type: 'text', text: 'change direction' }],
    })
  })

  it('deduplicates repeated provider call ids', async () => {
    const { context, sessions } = createContext(false)
    const tools = new DshVoiceTools(context, sessionId)
    const call = {
      callId: 'same-call',
      name: 'start_task',
      arguments: JSON.stringify({ instruction: 'build it' }),
    }
    const [first, second] = await Promise.all([tools.execute(call), tools.execute(call)])
    expect(first).toEqual(second)
    expect(sessions.prompt).toHaveBeenCalledTimes(1)
  })

  it('rejects non-allowlisted tools without touching DSH', async () => {
    const { context, sessions } = createContext(false)
    const tools = new DshVoiceTools(context, sessionId)
    const result = await tools.execute({ callId: 'bad', name: 'run_shell', arguments: '{}' })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('not allowed')
    expect(sessions.prompt).not.toHaveBeenCalled()
    expect(sessions.cancel).not.toHaveBeenCalled()
  })
})
