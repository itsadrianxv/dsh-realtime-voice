import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DshVoiceTools } from '../src/host/dsh-tools.ts'

const sessionId = 'session-test'

function ok(value: unknown = {}) {
  return { result: { ok: true as const, value } }
}

function createContext(running = false) {
  const sessions = {
    list: vi.fn(async () => ok({
      items: [
        {
          sessionId,
          running,
          blank: false,
          cwd: 'E:\\project',
          updatedAt: 100,
          projections: { values: { title: 'Current task' } },
        },
        {
          sessionId: 'session-wechat',
          running: false,
          blank: false,
          cwd: 'E:\\deepseek-harness',
          updatedAt: 200,
          projections: { values: { title: '做成微信小程序' } },
        },
      ],
    })),
    history: vi.fn(async ({ payload }: { payload: { sessionId: string } }) => ok({
      events: [{ event: {
        type: 'assistant/message',
        data: {
          message: {
            content: [{ type: 'reasoning', text: 'internal thought' }, { type: 'text', text: payload.sessionId === sessionId ? 'latest result' : '微信线程最后回复' }],
          },
        },
      } }],
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
      title: 'Current task',
      summary: 'latest result',
    })
  })

  it('finds another workspace session and reads its latest persisted reply', async () => {
    const { context, sessions } = createContext(false)
    const tools = new DshVoiceTools(context, sessionId)
    const listed = await tools.execute({
      callId: 'find-wechat',
      name: 'list_sessions',
      arguments: JSON.stringify({ query: '微信小程序', workspace: 'deepseek-harness' }),
    })
    expect(listed.ok).toBe(true)
    expect(JSON.parse(listed.output)).toMatchObject({
      count: 1,
      sessions: [{ sessionId: 'session-wechat', title: '做成微信小程序' }],
    })

    const latest = await tools.execute({
      callId: 'read-wechat',
      name: 'get_session_latest_reply',
      arguments: JSON.stringify({ sessionId: 'session-wechat' }),
    })
    expect(latest.ok).toBe(true)
    expect(JSON.parse(latest.output)).toMatchObject({
      session: { sessionId: 'session-wechat' },
      latestAssistantReply: '微信线程最后回复',
    })
    expect(sessions.history).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ sessionId: 'session-wechat' }),
    }))
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
