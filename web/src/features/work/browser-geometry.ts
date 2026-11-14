// Pure geometry for the live browser screenshot. The page is rendered at a fixed viewport (1280×800); the <img> showing its
// screenshot can be any size (small preview in the work panel, or `object-contain` inside the enlarged dialog, which letterboxes).
// No imports on purpose: server/test/browser-geometry.test.ts runs this file directly.

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}
export interface Viewport {
	width: number;
	height: number;
}

/**
 * Map a pointer position (client coordinates) over the screenshot element to page viewport coordinates, accounting for
 * `object-fit: contain` letterboxing. Returns null when the pointer is over the empty bars, not over the page.
 */
export function viewportPoint(box: Box, vp: Viewport, clientX: number, clientY: number): { x: number; y: number } | null {
	if (box.width <= 0 || box.height <= 0 || vp.width <= 0 || vp.height <= 0) return null;
	const scale = Math.min(box.width / vp.width, box.height / vp.height);
	const shownW = vp.width * scale;
	const shownH = vp.height * scale;
	const x = (clientX - box.left - (box.width - shownW) / 2) / scale;
	const y = (clientY - box.top - (box.height - shownH) / 2) / scale;
	if (x < 0 || y < 0 || x > vp.width || y > vp.height) return null;
	return { x: Math.round(x), y: Math.round(y) };
}

/** Wheel delta in page pixels: line / page modes are converted, then scaled from the shown size back to the viewport. */
export function scrollDelta(e: { deltaY: number; deltaMode: number }, shownWidth: number, viewportWidth: number): number {
	const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
	return shownWidth > 0 ? px * (viewportWidth / shownWidth) : px;
}
