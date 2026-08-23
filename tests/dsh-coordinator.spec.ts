import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { DshVoiceCoordinator, VOICE_COORDINATOR_PROMPT } from '../src/host/dsh-coordinator.ts'

const sessionId = 'session-voice-parent'

function ok(value: unknown = {}) {
  return { result: { ok: true as const, value } }
}

function createContext(running = false) {
  const prompt = vi.fn(async () => ok())
  const list = vi.fn(async () => ok({
    items: [{
      sessionId,
      running,
      blank: false,
      cwd: 'E:\\project',
      projections: { values: { title: 'Bound task' } },
    }],
  }))
  const models = vi.fn(async () => ok({
    current: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' },
  }))
  const create = vi.fn(async () => ok({ sessionId: 'session-worker' }))
  const selectModel = vi.fn(async () => ok())
  const rename = vi.fn(async () => ok({ title: 'Print WeChat document' }))
  const cancel = vi.fn(async () => ok())
  const history = vi.fn(async () => ok({ events: [] }))
  const sectionDispose = vi.fn()
  const section = vi.fn(() => sectionDispose)
  const tools = new Map<string, ToolDefinition>()
  const toolDisposers: Array<ReturnType<typeof vi.fn>> = []
  const register = vi.fn((definition: ToolDefinition) => {
    tools.set(definition.name, definition)
    const dispose = vi.fn(() => tools.delete(definition.name))
    toolDisposers.push(dispose)
    return dispose
  })
  const agent = { ctx: { systemPrompt: { section }, tools: { register } } }
  const context = {
    apiProxy: { sessions: { prompt, list, models, create, selectModel, rename, cancel, history } },
    agents: { get: vi.fn(() => agent) },
  } as never
  return {
    context,
    sessions: { prompt, list, models, create, selectModel, rename, cancel, history },
    scoped: { section, sectionDispose, register, tools, toolDisposers },
  }
}

function toolContext() {
  return { signal: new AbortController().signal } as never
}

describe('DSH-side realtime voice coordinator', () => {
  it('attaches one scoped prompt and four DSH tools, then disposes all of them', async () => {
    const { context, scoped } = createContext()
    const coordinator = new DshVoiceCoordinator(context, sessionId)

    await coordinator.attach()
    expect(scoped.section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'realtime-voice:coordinator',
      text: VOICE_COORDINATOR_PROMPT,
    }))
    expect([...scoped.tools.keys()]).toEqual([
      'voice_delegate_task',
      'voice_message_task',
      'voice_task_status',
      'voice_cancel_task',
    ])

    coordinator.dispose()
    expect(scoped.sectionDispose).toHaveBeenCalledTimes(1)
    expect(scoped.toolDisposers.every(dispose => dispose.mock.calls.length === 1)).toBe(true)
    expect(scoped.tools.size).toBe(0)
  })

  it('submits every final transcript to the bound Agent without keyword classification', async () => {
    const { context, sessions } = createContext(false)
    const coordinator = new DshVoiceCoordinator(context, sessionId)
    await coordinator.attach()

    await coordinator.submitUserTurn('嗨，今天怎么样？')
    await coordinator.submitUserTurn('打开微信里的文档并双面彩打')

    expect(sessions.prompt).toHaveBeenCalledTimes(2)
    expect(sessions.prompt.mock.calls.map(call => call[0].payload)).toEqual([
      expect.objectContaining({ sessionId, mode: 'queue', content: [{ type: 'text', text: '嗨，今天怎么样？' }] }),
      expect.objectContaining({ sessionId, mode: 'queue', content: [{ type: 'text', text: '打开微信里的文档并双面彩打' }] }),
    ])
  })

  it('steers a running bound Agent instead of creating a competing voice context', async () => {
    const { context, sessions } = createContext(true)
    const coordinator = new DshVoiceCoordinator(context, sessionId)
    await coordinator.attach()

    await coordinator.submitUserTurn('改成打两份')
    expect(sessions.prompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ sessionId, mode: 'steer' }),
    }))
  })

  it('delegates blocking work to a real DSH worker in the same cwd and model', async () => {
    const { context, sessions, scoped } = createContext(false)
    const onWorkerStarted = vi.fn()
    const coordinator = new DshVoiceCoordinator(context, sessionId, { onWorkerStarted })
    await coordinator.attach()

    const delegate = scoped.tools.get('voice_delegate_task')!
    const result = await delegate.execute({
      instruction: '找到微信文档，双面彩打，共两份',
      title: '打印微信文档',
    }, toolContext())

    expect(result).toEqual({ sessionId: 'session-worker', status: 'running', title: 'Print WeChat document' })
    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({ payload: { cwd: 'E:\\project' } }))
    expect(sessions.selectModel).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        sessionId: 'session-worker',
        provider: 'deepseek',
        model: 'deepseek-chat',
        reasoningEffort: 'medium',
      }),
    }))
    expect(sessions.prompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        sessionId: 'session-worker',
        mode: 'queue',
        content: [{ type: 'text', text: '找到微信文档，双面彩打，共两份' }],
      }),
    }))
    expect(onWorkerStarted).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-worker' }))
  })
})
