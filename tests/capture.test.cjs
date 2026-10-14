const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cropRect } = require('../electron/capture.cjs');

test('normalized selection maps to actual screenshot pixels at fractional DPI', () => {
  assert.deepEqual(cropRect({ x: .25, y: .25, width: .5, height: .5 }, { width: 2880, height: 1800 }), { x: 720, y: 450, width: 1440, height: 900 });
  assert.deepEqual(cropRect({ x: 0, y: 0, width: 1, height: 1 }, { width: 1920, height: 1080 }), { x: 0, y: 0, width: 1920, height: 1080 });
});
test('invalid, out-of-range and tiny selections never reach native crop', () => {
  for (const r of [null, {}, { x: NaN, y: 0, width: 1, height: 1 }, { x: -.1, y: 0, width: 1, height: 1 }, { x: .5, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: .001, height: .001 }]) assert.throws(() => cropRect(r, { width: 1920, height: 1080 }));
});
