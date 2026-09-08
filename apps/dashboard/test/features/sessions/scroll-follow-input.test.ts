import { expect, test } from "bun:test";
import { atLatestBottom, BottomFollowGesture } from "../../../src/features/sessions/use-scroll-follow-input";

const start = { top: 200, height: 1000, viewport: 400 };
const bottom = { ...start, top: 600 };
test("only user input can restore following, within 2px of a connected latest bottom", () => {
  const gesture = new BottomFollowGesture();
  expect(gesture.reachesBottom(bottom, true)).toBe(false);
  gesture.begin(start);
  expect(gesture.reachesBottom({ ...bottom, top: 597.9 }, true)).toBe(false);
  expect(gesture.reachesBottom({ ...bottom, top: 598 }, true)).toBe(true);
  expect(gesture.reachesBottom(bottom, false)).toBe(false);
  gesture.clear();
  expect(gesture.reachesBottom(bottom, true)).toBe(false);
  gesture.begin(bottom);
  expect(gesture.reachesBottom(bottom, true)).toBe(true);
  expect(atLatestBottom(bottom, false)).toBe(false);
});
test("a layout shrink, resize, or reverse scroll retires an earlier downward gesture", () => {
  for (const changed of [{ ...bottom, height: 600 }, { ...bottom, viewport: 800 }, { ...start, top: 190 }]) {
    const gesture = new BottomFollowGesture();
    gesture.begin(start);
    expect(gesture.reachesBottom(changed, true)).toBe(false);
    expect(gesture.reachesBottom(bottom, true)).toBe(false);
    gesture.begin(start);
    expect(gesture.reachesBottom(bottom, true)).toBe(true);
  }
});
