import { describe, expect, it, vi } from 'vitest'
import { DshFunctionBridge } from '../src/host/dsh-function-bridge.ts'

function coordinator() {
  return {
    handoff: vi.fn(async (instruction: string) => ({
      handoffId: 'handoff-1', sessionId: 'session-1', mode: 'queue', instruction,
    })),
    cancel: vi.fn(async () => ({ accepted: true })),
    listPendingApprovals: vi.fn(() => []),
    listPendingQuestions: vi.fn(() => []),
  }
}

describe('client-neutral DSH Function Call bridge', () => {
  it('executes concurrent duplicate callIds exactly once and returns a cached receipt', async () => {
    const target = coordinator()
    const bridge = new DshFunctionBridge(target as never)
    const args = JSON.stringify({ instruction: '打印读后感' })
    const [first, duplicate] = await Promise.all([
      bridge.execute('call-1', 'handoff_to_dsh_agent', args, ''),
      bridge.execute('call-1', 'handoff_to_dsh_agent', args, ''),
    ])
    expect(target.handoff).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({ ok: true, cached: false })
    expect(duplicate).toMatchObject({ ok: true, cached: true })
  })

  it('rejects non-whitelisted tools, extra properties, and conflicting callId reuse', async () => {
    const target = coordinator()
    const bridge = new DshFunctionBridge(target as never)
    await expect(bridge.execute('call-unknown', 'run_arbitrary_code', '{}', '')).resolves.toMatchObject({ ok: false })
    await expect(bridge.execute('call-extra', 'handoff_to_dsh_agent', JSON.stringify({
      instruction: '执行', root: true,
    }), '')).resolves.toMatchObject({ ok: false })
    await bridge.execute('call-conflict', 'handoff_to_dsh_agent', JSON.stringify({ instruction: 'A' }), '')
    await expect(bridge.execute('call-conflict', 'handoff_to_dsh_agent', JSON.stringify({ instruction: 'B' }), ''))
      .resolves.toMatchObject({ ok: false, cached: true })
    expect(target.handoff).toHaveBeenCalledTimes(1)
  })

  it('keeps the legacy empty-arguments form valid for cancellation', async () => {
    const target = coordinator()
    const bridge = new DshFunctionBridge(target as never)
    await expect(bridge.execute('call-cancel', 'cancel_dsh_agent', '', ''))
      .resolves.toMatchObject({ ok: true })
    expect(target.cancel).toHaveBeenCalledTimes(1)
  })

  it('claims one pending interaction before awaiting so voice and card answers cannot double-submit', async () => {
    let resolve!: (value: unknown) => void
    const pending = { rpcId: 'rpc-1', approvalId: 'approval-1', sessionId: 'session-1', toolName: 'print' }
    const target = {
      listPendingApprovals: vi.fn(() => [pending]),
      resolveApproval: vi.fn(() => new Promise(value => { resolve = value })),
      forgetApproval: vi.fn(),
    }
    const bridge = new DshFunctionBridge(target as never)
    const voice = bridge.answerApproval('approval-1', 'allowed-once')
    const card = bridge.answerApproval('approval-1', 'allowed-once')
    expect(target.resolveApproval).toHaveBeenCalledTimes(1)
    resolve({ accepted: true })
    await expect(Promise.all([voice, card])).resolves.toEqual([{ accepted: true }, { accepted: true }])
    expect(target.forgetApproval).toHaveBeenCalledTimes(1)
  })
})
