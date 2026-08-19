export interface FloatingPosition {
  x: number
  y: number
}

export interface FloatingSize {
  width: number
  height: number
}

export const FLOATING_MARGIN = 12

export function defaultFloatingPosition(viewport: FloatingSize, panel: FloatingSize): FloatingPosition {
  return clampFloatingPosition({
    x: viewport.width - panel.width - FLOATING_MARGIN,
    y: Math.max(72, viewport.height - panel.height - FLOATING_MARGIN),
  }, viewport, panel)
}

export function clampFloatingPosition(
  position: FloatingPosition,
  viewport: FloatingSize,
  panel: FloatingSize,
): FloatingPosition {
  const maxX = Math.max(FLOATING_MARGIN, viewport.width - panel.width - FLOATING_MARGIN)
  const maxY = Math.max(FLOATING_MARGIN, viewport.height - panel.height - FLOATING_MARGIN)
  return {
    x: Math.min(maxX, Math.max(FLOATING_MARGIN, position.x)),
    y: Math.min(maxY, Math.max(FLOATING_MARGIN, position.y)),
  }
}

export function moveFloatingPosition(
  origin: FloatingPosition,
  pointerStart: FloatingPosition,
  pointerNow: FloatingPosition,
  viewport: FloatingSize,
  panel: FloatingSize,
): FloatingPosition {
  return clampFloatingPosition({
    x: origin.x + pointerNow.x - pointerStart.x,
    y: origin.y + pointerNow.y - pointerStart.y,
  }, viewport, panel)
}
