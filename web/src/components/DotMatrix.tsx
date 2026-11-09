// Animated dot-matrix background for the home and chat pages (explicitly requested by the user; the earlier
// "no persistent animated background" rule is superseded, with the guards below).
//
// Guards:
//  - canvas 2D only, no assets; devicePixelRatio aware (capped at 2 to bound fill cost on 3x phones);
//  - slow two-wave shimmer + soft reaction to the pointer; ~30 fps (rAF callbacks that arrive earlier are skipped);
//  - low contrast and masked under the message column so text stays perfectly readable;
//  - theme aware: the dot colour is the `--dot-rgb` token, re-read when html[data-theme] changes;
//  - ZERO rAF callbacks while the tab is hidden or the canvas is offscreen (IntersectionObserver);
//  - static dots (one drawn frame, no loop) under prefers-reduced-motion and the in-app reduce-motion toggle;
//  - not rendered at all when the Settings toggle is off.
// `window.__wrDots` exposes counters (frames, rAF callbacks, draw time) for the browser checks.
import { useEffect, useRef } from "react";
import { usePrefs } from "@/lib/prefs";

export interface DotStats {
	mode: "animated" | "static" | "paused";
	/** Frames actually drawn (animated + static). */
	draws: number;
	/** rAF callbacks invoked by this component (drawn or skipped by the 30fps throttle). */
	rafCalls: number;
	avgDrawMs: number;
	maxDrawMs: number;
	dpr: number;
	dots: number;
	/** canvases in use: 2 (one on each side of the message column) or 1 (narrow screens) */
	regions: number;
	/** total backing-store pixels */
	pixels: number;
	width: number;
	height: number;
}
declare global {
	interface Window {
		__wrDots?: DotStats;
	}
}

const SPACING = 24; // CSS px between dots
const FRAME_MS = 1000 / 30;
const BUCKETS = 8;
const TAU = Math.PI * 2;
const POINTER_R = 130;

const smooth = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

export function DotMatrix({ column = 760, floor, strength = 1 }: { column?: number; /** alpha factor under the column (0..1) */ floor?: number; strength?: number }) {
	const { dotMatrix, motionReduced } = usePrefs();
	if (!dotMatrix) return null;
	return <DotCanvas column={column} floor={floor} strength={strength} reduced={motionReduced} />;
}

interface Region {
	cv: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	x0: number;
	w: number;
	n: number;
	xs: Float32Array;
	ys: Float32Array;
	mask: Float32Array;
}

function DotCanvas({ column, floor, strength, reduced }: { column: number; floor?: number; strength: number; reduced: boolean }) {
	const wrap = useRef<HTMLDivElement>(null);
	const cvA = useRef<HTMLCanvasElement>(null);
	const cvB = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const root = wrap.current;
		const a = cvA.current;
		const b = cvB.current;
		const ca = a?.getContext("2d");
		const cb = b?.getContext("2d");
		if (!root || !a || !b || !ca || !cb) return;

		let w = 0;
		let h = 0;
		let dpr = 1;
		let regions: Region[] = [];
		let rgb = "28,29,31";
		let peak = 0.22;
		let visible = true;
		let raf = 0;
		let last = 0;
		let disposed = false;
		const t0 = performance.now();
		const ptr = { x: -1e4, y: -1e4, target: 0, v: 0, moved: 0 };
		let idx = Array.from({ length: BUCKETS }, () => new Int32Array(0));
		const cnt = new Int32Array(BUCKETS);
		const stats: DotStats = { mode: reduced ? "static" : "paused", draws: 0, rafCalls: 0, avgDrawMs: 0, maxDrawMs: 0, dpr: 1, dots: 0, regions: 0, pixels: 0, width: 0, height: 0 };
		window.__wrDots = stats;

		const readColor = () => {
			const cs = getComputedStyle(document.documentElement);
			const parts = cs.getPropertyValue("--dot-rgb").trim().split(/[\s,]+/).filter(Boolean);
			rgb = parts.length >= 3 ? parts.slice(0, 3).join(",") : "128,128,128";
			const al = parseFloat(cs.getPropertyValue("--dot-alpha"));
			peak = Number.isFinite(al) && al > 0 ? al : 0.2;
		};

		// Wide screens: two canvases, one on each side of the message column — nothing is drawn (or composited) behind the
		// text at all, and the pixel count is a third of a full-page canvas. Narrow screens: one full canvas, dimmed.
		const layout = () => {
			const r = root.getBoundingClientRect();
			if (r.width < 8 || r.height < 8) return false;
			w = r.width;
			h = r.height;
			dpr = Math.min(window.devicePixelRatio || 1, 2);
			const side = w - column > 240;
			const rects = side
				? [
						{ cv: a, ctx: ca, x0: 0, w: Math.floor((w - column) / 2) },
						{ cv: b, ctx: cb, x0: w - Math.floor((w - column) / 2), w: Math.floor((w - column) / 2) },
					]
				: [{ cv: a, ctx: ca, x0: 0, w: Math.round(w) }];
			b.style.display = side ? "block" : "none";
			const lo = floor ?? (side ? 0 : w < 640 ? 0.5 : 0.3);
			const cols = Math.ceil(w / SPACING) + 1;
			const rows = Math.ceil(h / SPACING) + 1;
			const ox = (w - (cols - 1) * SPACING) / 2;
			const cx = w / 2;
			let total = 0;
			let pixels = 0;
			regions = rects.map((rc) => {
				rc.cv.style.left = `${rc.x0}px`;
				rc.cv.style.width = `${rc.w}px`;
				rc.cv.style.height = `${h}px`;
				rc.cv.width = Math.max(1, Math.round(rc.w * dpr));
				rc.cv.height = Math.max(1, Math.round(h * dpr));
				rc.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				pixels += rc.cv.width * rc.cv.height;
				const xs: number[] = [];
				const ys: number[] = [];
				const mk: number[] = [];
				for (let r2 = 0; r2 < rows; r2++)
					for (let c = 0; c < cols; c++) {
						const gx = ox + c * SPACING;
						if (gx < rc.x0 - 1 || gx > rc.x0 + rc.w + 1) continue;
						const y = r2 * SPACING + SPACING / 2;
						const d = Math.abs(gx - cx) - column / 2;
						const edge = lo + (1 - lo) * smooth(side ? 0 : -10, 170, d);
						// gentle vignette towards the very top and bottom so the bars read as calm bands
						const v = 0.55 + 0.45 * smooth(0, 90, Math.min(y, h - y));
						xs.push(gx - rc.x0);
						ys.push(y);
						mk.push(edge * v);
					}
				total += xs.length;
				return { cv: rc.cv, ctx: rc.ctx, x0: rc.x0, w: rc.w, n: xs.length, xs: Float32Array.from(xs), ys: Float32Array.from(ys), mask: Float32Array.from(mk) };
			});
			const max = Math.max(...regions.map((x) => x.n), 1);
			idx = idx.map((arr) => (arr.length < max ? new Int32Array(max) : arr));
			stats.dpr = dpr;
			stats.dots = total;
			stats.regions = regions.length;
			stats.pixels = pixels;
			stats.width = Math.round(w);
			stats.height = Math.round(h);
			return true;
		};

		const wave = (x: number, y: number, w1: number, w2: number) => 0.62 + 0.24 * Math.sin(x * 0.011 + y * 0.006 - w1) + 0.14 * Math.sin(x * -0.007 + y * 0.013 + w2 + 1.3);

		const drawRegion = (g: Region, t: number, px: number, py: number) => {
			const { ctx, xs, ys, mask, n } = g;
			ctx.clearRect(0, 0, g.w, h);
			cnt.fill(0);
			const base = peak * 0.85 * strength;
			const near: number[] = [];
			const w1 = t * 0.62;
			const w2 = t * 0.37;
			const hot = ptr.v > 0.01;
			for (let i = 0; i < n; i++) {
				const x = xs[i]!;
				const y = ys[i]!;
				if (hot) {
					const dx = x + g.x0 - px;
					const dy = y - py;
					if (dx * dx + dy * dy < POINTER_R * POINTER_R) {
						near.push(i);
						continue;
					}
				}
				// two slow travelling waves of different direction/period = soft shimmer, no visible "sweep"
				const al = base * wave(x + g.x0, y, w1, w2) * mask[i]!;
				if (al < 0.004) continue;
				const bk = Math.min(BUCKETS - 1, Math.floor((al / (peak * strength)) * BUCKETS));
				idx[bk]![cnt[bk]!++] = i;
			}
			for (let bk = 0; bk < BUCKETS; bk++) {
				const c = cnt[bk]!;
				if (!c) continue;
				ctx.fillStyle = `rgba(${rgb},${(((bk + 0.5) / BUCKETS) * peak * strength).toFixed(3)})`;
				ctx.beginPath();
				const list = idx[bk]!;
				for (let k = 0; k < c; k++) {
					const i = list[k]!;
					ctx.moveTo(xs[i]! + 1.1, ys[i]!);
					ctx.arc(xs[i]!, ys[i]!, 1.1, 0, TAU);
				}
				ctx.fill();
			}
			// dots near the pointer swell and brighten a little (soft falloff), drawn individually
			for (const i of near) {
				const x = xs[i]!;
				const y = ys[i]!;
				const d = Math.hypot(x + g.x0 - px, y - py);
				const k = (1 - d / POINTER_R) ** 2 * ptr.v;
				const al = Math.min(0.5, base * wave(x + g.x0, y, w1, w2) * mask[i]! + k * 0.3 * strength * (0.45 + 0.55 * mask[i]!));
				ctx.fillStyle = `rgba(${rgb},${al.toFixed(3)})`;
				ctx.beginPath();
				ctx.arc(x, y, 1.1 + k * 1.25, 0, TAU);
				ctx.fill();
			}
		};

		const draw = (tms: number, still: boolean) => {
			if (!regions.length) return;
			const s0 = performance.now();
			const t = still ? 2.2 : (tms - t0) / 1000;
			// pointer influence is evaluated in page space; the rect is read once per drawn frame, only while the pointer is near
			let px = -1e4;
			let py = -1e4;
			if (ptr.v > 0.01) {
				const rc = root.getBoundingClientRect();
				px = ptr.x - rc.left;
				py = ptr.y - rc.top;
			}
			for (const g of regions) drawRegion(g, t, px, py);
			const ms = performance.now() - s0;
			stats.draws++;
			stats.avgDrawMs += (ms - stats.avgDrawMs) / Math.min(stats.draws, 120);
			if (ms > stats.maxDrawMs) stats.maxDrawMs = ms;
		};

		const frame = (now: number) => {
			raf = 0;
			if (disposed) return;
			stats.rafCalls++;
			// stop condition re-checked here too: the loop never reschedules itself while hidden/offscreen
			if (document.hidden || !visible) {
				stats.mode = "paused";
				return;
			}
			if (now - last >= FRAME_MS - 1) {
				last = now;
				ptr.target = now - ptr.moved < 1600 ? 1 : 0;
				ptr.v += (ptr.target - ptr.v) * 0.18;
				if (ptr.v < 0.01 && ptr.target === 0) ptr.v = 0;
				draw(now, false);
			}
			raf = requestAnimationFrame(frame);
		};

		const sync = () => {
			if (disposed) return;
			const shouldRun = !reduced && visible && !document.hidden;
			if (shouldRun) {
				stats.mode = "animated";
				if (!raf) raf = requestAnimationFrame(frame);
			} else {
				if (raf) cancelAnimationFrame(raf);
				raf = 0;
				stats.mode = reduced ? "static" : "paused";
			}
		};

		const redrawStatic = () => {
			if (reduced) draw(0, true);
			else if (!raf && visible && !document.hidden) draw(performance.now(), false);
		};

		readColor();
		layout();
		redrawStatic();
		sync();

		let resizeT = 0;
		const ro = new ResizeObserver(() => {
			window.clearTimeout(resizeT);
			resizeT = window.setTimeout(() => {
				if (layout()) redrawStatic();
			}, 120);
		});
		ro.observe(root);
		const io = new IntersectionObserver((es) => {
			visible = es[es.length - 1]?.isIntersecting ?? true;
			sync();
		});
		io.observe(root);
		const onVis = () => sync();
		document.addEventListener("visibilitychange", onVis);
		const mo = new MutationObserver(() => {
			readColor();
			redrawStatic();
		});
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		const onMove = (e: PointerEvent) => {
			if (e.pointerType === "touch") return;
			ptr.x = e.clientX;
			ptr.y = e.clientY;
			ptr.moved = performance.now();
		};
		if (!reduced) window.addEventListener("pointermove", onMove, { passive: true });
		const onDpr = () => {
			if (layout()) redrawStatic();
		};
		window.addEventListener("resize", onDpr);

		return () => {
			disposed = true;
			if (raf) cancelAnimationFrame(raf);
			window.clearTimeout(resizeT);
			ro.disconnect();
			io.disconnect();
			mo.disconnect();
			document.removeEventListener("visibilitychange", onVis);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("resize", onDpr);
			if (window.__wrDots === stats) delete window.__wrDots;
		};
	}, [reduced, column, floor, strength]);

	return (
		<div ref={wrap} aria-hidden data-testid="dot-matrix" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
			<canvas ref={cvA} className="absolute top-0 block" />
			<canvas ref={cvB} className="absolute top-0 block" />
		</div>
	);
}
