// Live bot avatar on a canvas, built on the vendored open-bot-avatar renderer (shared/bot-avatar, MIT — see NOTICE.md).
//
// Cost model (many avatars live on one page):
//  - "calm" (default): the body is still and only blinks. Between blinks nothing runs at all — one timer sleeps until the next blink,
//    during a blink (~0.2 s) it redraws at 30 fps. A page of 50 resting avatars therefore does ~nothing.
//  - "thinking" / "happy" (an expert at work): the full animation, drawn per animation frame (30 fps for small avatars).
//  - Off screen (IntersectionObserver) or in a hidden tab: no timers, no frames; it redraws once when it comes back.
//  - Reduced motion (system or in-app): one static frame, never any timer.
import { createAnimator } from "@shared/bot-avatar/animator.ts";
import { calmBlink, hashString, nextCalmBlink } from "@shared/bot-avatar/motion.ts";
import { liveFrame, renderAvatarSvg } from "@shared/bot-avatar/render.ts";
import type { AvatarDefinition, AvatarMotion } from "@shared/bot-avatar/types.ts";
import { canvasSupported, mountCanvas, paintCanvas, type CanvasSurface } from "./paint.ts";

export type BotMood = Extract<AvatarMotion, "calm" | "thinking" | "happy">;
export interface BotOptions {
	def: AvatarDefinition;
	color: string;
	eyeColor: string;
	mood: BotMood;
	reducedMotion: boolean;
	/** Square size in CSS px. */
	size: number;
	/** A single static SVG, no canvas and no timers (thumbnails in pickers). */
	still?: boolean;
}
export interface BotHandle {
	update(next: Partial<BotOptions>): void;
	destroy(): void;
}

const SMALL_FPS_GAP = 1000 / 30 - 3;
/** Depth of the implied 3D volume: a little flatter at small sizes, where extra relief only blurs. */
const depthFor = (size: number) => (size < 40 ? 4 : 6);

/** One IntersectionObserver for all avatars. */
const callbacks = new WeakMap<Element, (visible: boolean) => void>();
let io: IntersectionObserver | null | undefined;
function observe(el: Element, cb: (visible: boolean) => void): () => void {
	if (io === undefined) {
		io =
			typeof IntersectionObserver === "undefined"
				? null
				: new IntersectionObserver(
						(entries) => {
							for (const e of entries) callbacks.get(e.target)?.(e.isIntersecting);
						},
						{ rootMargin: "80px" },
					);
	}
	if (!io) return () => {};
	callbacks.set(el, cb);
	io.observe(el);
	return () => {
		callbacks.delete(el);
		io?.unobserve(el);
	};
}

/** Counters for tests / diagnostics: avatars mounted, frames drawn, and avatars with a timer or frame pending right now (0 = idle page). */
export const botStats = { mounted: 0, drawn: 0, pending: 0 };
(globalThis as { __wrBotStats?: typeof botStats }).__wrBotStats = botStats;

export function mountBot(host: HTMLElement, initial: BotOptions): BotHandle {
	let o = { ...initial };
	botStats.mounted++;
	const animator = createAnimator();
	const startedAt = performance.now();
	let surface: CanvasSurface | null = null;
	let surfaceKey = "";
	let visible = true;
	let destroyed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let raf = 0;
	let lastDraw = -1e9;
	let stillMarkup = "";
	const seed = () => hashString(o.def.id);

	let pending = false;
	const mark = (on: boolean) => {
		if (on === pending) return;
		pending = on;
		botStats.pending += on ? 1 : -1;
	};
	const stop = () => {
		if (timer !== undefined) clearTimeout(timer);
		if (raf) cancelAnimationFrame(raf);
		timer = undefined;
		raf = 0;
		mark(false);
	};

	/** Draw one frame; returns when the next one is needed: "frame", seconds to wait, or false (nothing more until a change). */
	const draw = (): "frame" | number | false => {
		const now = performance.now();
		lastDraw = now;
		botStats.drawn++;
		const time = (now - startedAt) / 1000;
		const depth = depthFor(o.size);
		const key = `${o.def.id}|${o.def.body.path}|${JSON.stringify(o.def.eyes)}|${depth}`;
		if (!surface || surfaceKey !== key || !host.contains(surface.canvas)) {
			surface = mountCanvas(host, key, o.def, depth);
			surfaceKey = key;
		}
		const step = animator.step({ now, motion: o.mood, target: null, reducedMotion: o.reducedMotion });
		const frame = liveFrame(o.def, { depth, motion: o.mood, motionBlend: step.motionBlend, size: o.size, time, reducedMotion: o.reducedMotion });
		paintCanvas(surface, frame, o.size, o.color, o.eyeColor);
		if (o.reducedMotion) return false;
		if (step.moving || o.mood !== "calm") return "frame";
		if (calmBlink(seed(), time) > 0) return "frame";
		return nextCalmBlink(seed(), time);
	};

	const schedule = (next: "frame" | number | false) => {
		if (next === false || destroyed || !visible || document.hidden) return mark(false);
		mark(true);
		if (next === "frame") {
			raf = requestAnimationFrame(() => {
				raf = 0;
				// 30 fps is plenty at avatar sizes.
				if (performance.now() - lastDraw < SMALL_FPS_GAP) return schedule("frame");
				run();
			});
		} else timer = setTimeout(run, Math.max(next * 1000 - 20, 16));
	};
	const run = () => {
		timer = undefined;
		if (destroyed || !visible || document.hidden) return;
		schedule(draw());
	};
	const kick = () => {
		stop();
		if (destroyed) return;
		if (o.still || !canvasSupported()) {
			const svg = renderAvatarSvg(o.def, { color: o.color, eyeColor: o.eyeColor, size: o.size, depth: depthFor(o.size), motion: "calm", reducedMotion: true });
			if (svg !== stillMarkup || !host.firstChild) {
				host.innerHTML = svg;
				stillMarkup = svg;
			}
			return;
		}
		// A change always draws (even off screen, so the content is current when it scrolls in); only the follow-up frames wait for visibility.
		const next = draw();
		if (visible && !document.hidden) schedule(next);
	};

	const unobserve = observe(host, (v) => {
		if (v === visible) return;
		visible = v;
		if (v) kick();
		else stop();
	});
	const onVisibility = () => (document.hidden ? stop() : kick());
	document.addEventListener("visibilitychange", onVisibility);

	host.style.width = host.style.height = `${o.size}px`;
	if (getComputedStyle(host).position === "static") host.style.position = "relative";
	kick();

	return {
		update(next) {
			const sizeChanged = next.size !== undefined && next.size !== o.size;
			o = { ...o, ...next };
			if (sizeChanged) host.style.width = host.style.height = `${o.size}px`;
			kick();
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			botStats.mounted--;
			stop();
			unobserve();
			document.removeEventListener("visibilitychange", onVisibility);
			host.textContent = "";
		},
	};
}
