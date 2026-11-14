// Pure geometry behind the enlarged browser dialog: pointer → page viewport coordinates with object-contain letterboxing, wheel → page pixels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrollDelta, viewportPoint } from "../../web/src/features/work/browser-geometry.ts";

const VP = { width: 1280, height: 800 };

test("viewportPoint: a same-aspect box maps linearly", () => {
	const box = { left: 100, top: 50, width: 640, height: 400 };
	assert.deepEqual(viewportPoint(box, VP, 100, 50), { x: 0, y: 0 });
	assert.deepEqual(viewportPoint(box, VP, 420, 250), { x: 640, y: 400 });
	assert.deepEqual(viewportPoint(box, VP, 740, 450), { x: 1280, y: 800 });
});

test("viewportPoint: letterboxing — a wide box leaves side bars, a tall box leaves top/bottom bars", () => {
	// 2000×800 box: the page is shown 1280×800 at scale 1, centered with 360px bars left and right.
	const wide = { left: 0, top: 0, width: 2000, height: 800 };
	assert.equal(viewportPoint(wide, VP, 100, 400), null, "inside the left bar");
	assert.deepEqual(viewportPoint(wide, VP, 360, 0), { x: 0, y: 0 });
	assert.deepEqual(viewportPoint(wide, VP, 1000, 400), { x: 640, y: 400 });
	// 640×800 box: scale 0.5, page shown 640×400, bars of 200px above and below.
	const tall = { left: 10, top: 10, width: 640, height: 800 };
	assert.equal(viewportPoint(tall, VP, 100, 100), null, "inside the top bar");
	assert.deepEqual(viewportPoint(tall, VP, 330, 410), { x: 640, y: 400 });
});

test("viewportPoint: degenerate sizes give null", () => {
	assert.equal(viewportPoint({ left: 0, top: 0, width: 0, height: 100 }, VP, 1, 1), null);
	assert.equal(viewportPoint({ left: 0, top: 0, width: 100, height: 100 }, { width: 0, height: 0 }, 1, 1), null);
});

test("scrollDelta: scales the shown size back to the viewport and converts line / page modes", () => {
	assert.equal(scrollDelta({ deltaY: 100, deltaMode: 0 }, 640, 1280), 200);
	assert.equal(scrollDelta({ deltaY: 100, deltaMode: 0 }, 1280, 1280), 100);
	assert.equal(scrollDelta({ deltaY: 3, deltaMode: 1 }, 1280, 1280), 48);
	assert.equal(scrollDelta({ deltaY: 1, deltaMode: 2 }, 1280, 1280), 800);
	assert.equal(scrollDelta({ deltaY: -50, deltaMode: 0 }, 0, 1280), -50);
});
