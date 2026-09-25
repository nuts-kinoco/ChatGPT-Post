export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowPosition {
  x: number;
  y: number;
}

/** A Display work area is where this non-taskbar window may be placed. */
export type DisplayWorkArea = WindowBounds;

export function boundsAt(position: WindowPosition, width: number, height: number): WindowBounds {
  return { x: position.x, y: position.y, width, height };
}

export function fitsWithinWorkArea(bounds: WindowBounds, workArea: DisplayWorkArea): boolean {
  return bounds.width <= workArea.width
    && bounds.height <= workArea.height
    && bounds.x >= workArea.x
    && bounds.y >= workArea.y
    && bounds.x + bounds.width <= workArea.x + workArea.width
    && bounds.y + bounds.height <= workArea.y + workArea.height;
}

export function fitsWithinAnyWorkArea(bounds: WindowBounds, workAreas: readonly DisplayWorkArea[]): boolean {
  return workAreas.some((workArea) => fitsWithinWorkArea(bounds, workArea));
}

/**
 * Keeps a rectangle inside one display work area.  The size reduction is only
 * relevant for an unusually small display; normal displays keep the bar's
 * configured dimensions unchanged.
 */
export function clampToWorkArea(bounds: WindowBounds, workArea: DisplayWorkArea): WindowBounds {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}

/**
 * Places the popup at the bar's anchor whenever it fits below the bar.  Near
 * an edge, only the popup is moved to keep it inside the work area; callers
 * retain the anchor separately so closing can restore the collapsed bar.
 */
export function popupBoundsForAnchor(anchor: WindowPosition, width: number, popupHeight: number, workArea: DisplayWorkArea): WindowBounds {
  const downward = boundsAt(anchor, width, popupHeight);
  return fitsWithinWorkArea(downward, workArea) ? downward : clampToWorkArea(downward, workArea);
}

export function bottomRightPosition(workArea: DisplayWorkArea, width: number, height: number, margin: number): WindowPosition {
  const fitted = clampToWorkArea({
    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + workArea.height - height - margin,
    width,
    height,
  }, workArea);
  return { x: fitted.x, y: fitted.y };
}

export function isSavedPositionValid(position: WindowPosition, width: number, height: number, workAreas: readonly DisplayWorkArea[]): boolean {
  return fitsWithinAnyWorkArea(boundsAt(position, width, height), workAreas);
}
