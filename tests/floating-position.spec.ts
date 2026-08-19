import { describe, expect, it } from 'vitest'
import {
  clampFloatingPosition,
  defaultFloatingPosition,
  moveFloatingPosition,
} from '../src/client/floating-position.ts'

describe('floating voice surface positioning', () => {
  it('starts at the lower right while staying inside the viewport', () => {
    expect(defaultFloatingPosition(
      { width: 1440, height: 900 },
      { width: 372, height: 560 },
    )).toEqual({ x: 1056, y: 328 })
  })

  it('clamps arbitrary dragging and viewport resizing', () => {
    expect(moveFloatingPosition(
      { x: 100, y: 100 },
      { x: 10, y: 10 },
      { x: -500, y: 2_000 },
      { width: 800, height: 600 },
      { width: 372, height: 400 },
    )).toEqual({ x: 12, y: 188 })
    expect(clampFloatingPosition(
      { x: 700, y: 500 },
      { width: 600, height: 420 },
      { width: 372, height: 400 },
    )).toEqual({ x: 216, y: 12 })
  })
})
