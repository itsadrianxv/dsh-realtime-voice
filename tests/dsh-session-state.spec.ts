import { describe, expect, it, vi } from 'vitest'
import { assistantText, DshVoiceSession } from '../src/host/dsh-session-state.ts'

const sessionId = 'session-test'

function ok(value: unknown = {}) {
  return { result: { ok: true as const, value } }
}

function createContext() {
  const sessions = {
    list: vi.fn(async () => ok({
      items: [{
        sessionId,
        running: true,
        blank: false,
        cwd: 'E:\\project',
        projections: { values: { title: 'Current task' } },
      }],
    })),
    history: vi.fn(async () => ok({
      events: [{ event: {
        type: 'assistant/message',
        data: {
          message: {
            content: [
              { type: 'reasoning', text: 'internal thought' },
              { type: 'text', text: 'latest result' },
            ],
          },
        },
      } }],
    })),
  }
  return { context: { apiProxy: { sessions } } as never, sessions }
}

describe('DSH voice session binding', () => {
  it('reads authoritative state and recent assistant text without exposing action routing', async () => {
    const { context } = createContext()
    const session = new DshVoiceSession(context, sessionId)

    await expect(session.snapshot()).resolves.toEqual({
      sessionId,
      running: true,
      blank: false,
      cwd: 'E:\\project',
      title: 'Current task',
      summary: 'latest result',
    })
  })

  it('extracts only user-visible text from a persisted assistant message', () => {
    expect(assistantText({
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'hidden' },
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      },
    })).toBe('first\nsecond')
  })
})

