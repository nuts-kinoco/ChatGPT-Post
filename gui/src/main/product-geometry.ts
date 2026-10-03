import type { WindowBounds, WindowPosition } from "./bar-position.js";
export const PRODUCT_BAR_HEIGHT = 46;
export const PRODUCT_PANEL_HEIGHT = 604;
export const PRODUCT_WIDTH = 440;
/** Option A's 604px is the total expanded outer height, including its 46px header. */
export function productBounds(anchor: WindowPosition, area: WindowBounds, expanded: boolean): WindowBounds {
  const width = Math.min(PRODUCT_WIDTH, area.width);
  const height = Math.min(expanded ? PRODUCT_PANEL_HEIGHT : PRODUCT_BAR_HEIGHT, area.height);
  return { width, height, x: Math.max(area.x, Math.min(anchor.x, area.x+area.width-width)), y: Math.max(area.y, Math.min(anchor.y, area.y+area.height-height)) };
}
export function initialProductAnchor(area: WindowBounds): WindowPosition {
  return { x: Math.max(area.x,area.x+area.width-PRODUCT_WIDTH-24), y:Math.min(area.y+24,area.y+area.height-PRODUCT_BAR_HEIGHT) };
}
