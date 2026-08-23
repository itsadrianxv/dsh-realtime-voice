import { describe, expect, it, vi } from 'vitest'
import {
  createDshVoiceCoordinatorState,
  DshVoiceCoordinator,
  type PendingVoiceApproval,
  type PendingVoiceQuestion,
} from '../src/host/dsh-coordinator.ts'

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
  const cancel = vi.fn(async () => ok())
  const respond = vi.fn(async () => ({ accepted: true as const }))
  const context = { apiProxy: { sessions: { prompt, list, cancel }, respond } } as never
  return { context, sessions: { prompt, list, cancel }, respond }
}

describe('DSH semantic execution coordinator', () => {
  it('queues one explicit execution handoff while the bound session is idle', async () => {
    const { context, sessions } = createContext(false)
    const coordinator = new DshVoiceCoordinator(context, sessionId)

    const result = await coordinator.handoff('打开微信文档并双面彩打', '帮我把微信里的读后感彩打')

    expect(result).toMatchObject({ sessionId, mode: 'queue', status: 'accepted' })
    expect(sessions.prompt).toHaveBeenCalledTimes(1)
    expect(sessions.prompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: expect.stringContaining('<realtime_delegation') }],
      }),
    }))
    expect(JSON.stringify(sessions.prompt.mock.calls[0])).toContain('打开微信文档并双面彩打')
  })

  it('steers the same active DSH turn instead of creating a shadow worker', async () => {
    const { context, sessions } = createContext(true)
    const coordinator = new DshVoiceCoordinator(context, sessionId)

    const result = await coordinator.handoff('改成彩打两份', '改成两份')

    expect(result.mode).toBe('steer')
    expect(sessions.prompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ sessionId, mode: 'steer' }),
    }))
  })

  it('answers a pending DSH approval through the original mux rpcId', async () => {
    const { context, respond } = createContext(true)
    const coordinator = new DshVoiceCoordinator(context, sessionId)
    const approval: PendingVoiceApproval = {
      rpcId: 'rpc-approval',
      approvalId: 'approval-1',
      sessionId,
      toolName: 'exec_command',
      reason: '需要访问打印机',
    }
    coordinator.rememberApproval(approval)

    await coordinator.resolveApproval('approval-1', 'allowed-once')

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      type: 'client-response',
      rpcId: 'rpc-approval',
      result: { ok: true, value: { sessionId, approvalId: 'approval-1', outcome: 'allowed-once' } },
    }))
  })

  it('answers a structured DSH question through the original mux rpcId', async () => {
    const { context, respond } = createContext(true)
    const coordinator = new DshVoiceCoordinator(context, sessionId)
    const question: PendingVoiceQuestion = {
      rpcId: 'rpc-question',
      sessionId,
      questions: [{ id: 'copies', question: '打印几份？', options: [{ label: '两份' }] }],
    }
    coordinator.rememberQuestion(question)

    await coordinator.answerQuestion('rpc-question', [{ id: 'copies', selected: ['两份'] }])

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      rpcId: 'rpc-question',
      result: { ok: true, value: { sessionId, answer: { answers: [{ id: 'copies', selected: ['两份'] }] } } },
    }))
  })

  it('keeps handoff and pending-interaction state across a transport reconnect', async () => {
    const { context } = createContext(false)
    const shared = createDshVoiceCoordinatorState()
    const first = new DshVoiceCoordinator(context, sessionId, shared)
    const handoff = await first.handoff('执行任务', '执行任务')
    first.rememberApproval({
      rpcId: 'rpc-approval',
      approvalId: 'approval-1',
      sessionId,
      toolName: 'exec_command',
    })

    const recovered = new DshVoiceCoordinator(context, sessionId, shared)
    expect(recovered.active).toBe(true)
    expect(recovered.listPendingApprovals()).toHaveLength(1)
    recovered.markTurnStarted(7)
    recovered.markTurnEnded(7, 'completed')
    expect(shared.handoffs.get(handoff.handoffId)?.status).toBe('completed')
  })
})
