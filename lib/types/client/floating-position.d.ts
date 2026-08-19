export interface FloatingPosition {
    x: number;
    y: number;
}
export interface FloatingSize {
    width: number;
    height: number;
}
export declare const FLOATING_MARGIN = 12;
export declare function defaultFloatingPosition(viewport: FloatingSize, panel: FloatingSize): FloatingPosition;
export declare function clampFloatingPosition(position: FloatingPosition, viewport: FloatingSize, panel: FloatingSize): FloatingPosition;
export declare function moveFloatingPosition(origin: FloatingPosition, pointerStart: FloatingPosition, pointerNow: FloatingPosition, viewport: FloatingSize, panel: FloatingSize): FloatingPosition;
