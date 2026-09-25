import assert from "node:assert/strict";
import test from "node:test";
import { bottomRightPosition, clampToWorkArea, fitsWithinAnyWorkArea, fitsWithinWorkArea, isSavedPositionValid, popupBoundsForAnchor } from "../dist/main/bar-position.js";

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const portraitLeft = { x: -1080, y: 0, width: 1080, height: 1880 };

test("the default bar position is inset from the selected display's bottom-right corner", () => {
  assert.deepEqual(bottomRightPosition(primary, 380, 40, 12), { x: 1528, y: 988 });
  assert.deepEqual(bottomRightPosition(portraitLeft, 380, 520, 12), { x: -392, y: 1348 });
});

test("clamping moves a boundary-spanning rectangle wholly into its matched display", () => {
  const straddling = { x: -100, y: 300, width: 380, height: 520 };
  const clamped = clampToWorkArea(straddling, portraitLeft);
  assert.deepEqual(clamped, { x: -380, y: 300, width: 380, height: 520 });
  assert.equal(fitsWithinWorkArea(clamped, portraitLeft), true);
  assert.equal(fitsWithinWorkArea(clamped, primary), false);
});

test("a saved position is accepted only when the complete current bar fits one connected display", () => {
  const displays = [portraitLeft, primary];
  assert.equal(isSavedPositionValid({ x: 1200, y: 400 }, 380, 40, displays), true);
  assert.equal(isSavedPositionValid({ x: -100, y: 400 }, 380, 40, displays), false, "it straddles the two displays");
  assert.equal(isSavedPositionValid({ x: 1800, y: 400 }, 380, 40, displays), false, "it extends past the primary display");
  assert.equal(fitsWithinAnyWorkArea({ x: -900, y: 100, width: 380, height: 40 }, displays), true);
});

test("the popup expands downward from its anchor when there is room", () => {
  const anchor = { x: 700, y: 300 };
  assert.deepEqual(popupBoundsForAnchor(anchor, 380, 520, primary), { x: 700, y: 300, width: 380, height: 520 });
  assert.deepEqual(anchor, { x: 700, y: 300 }, "positioning must not mutate the collapsed-bar anchor");
});

test("an edge-clamped popup leaves its collapsed-bar anchor unchanged", () => {
  const anchor = { x: 700, y: 900 };
  const popup = popupBoundsForAnchor(anchor, 380, 520, primary);
  assert.deepEqual(popup, { x: 700, y: 520, width: 380, height: 520 });
  assert.deepEqual(anchor, { x: 700, y: 900 });
  assert.equal(fitsWithinWorkArea(popup, primary), true);
});
