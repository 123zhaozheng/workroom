// FLIP list motion with the Web Animations API (no library): rows that keep their place glide from where they were, rows that are new
// slide/fade in, rows that disappeared fade out as a ghost. Rows are matched by `data-flip-id` inside the container, wherever they sit in
// it, so a row that moves from one group to another glides across. Positions are kept in the container's content coordinates, so
// scrolling between two changes does not produce phantom motion. `enabled` = false (reduced motion) skips every animation.
import { useLayoutEffect, useRef, type RefObject } from "react";

const DURATION = 250;
const EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const ATTR = "data-flip-id";
const THRESHOLD = 0.5;

interface Snap {
	el: HTMLElement;
	x: number;
	y: number;
	w: number;
	h: number;
}

function measure(root: HTMLElement): Map<string, Snap> {
	const m = new Map<string, Snap>();
	const r0 = root.getBoundingClientRect();
	for (const el of root.querySelectorAll<HTMLElement>(`[${ATTR}]`)) {
		// Rows inside a collapsed group are clipped away: they have no visible place to move from or to.
		if (el.closest("[inert]")) continue;
		const r = el.getBoundingClientRect();
		m.set(el.getAttribute(ATTR)!, { el, x: r.left - r0.left + root.scrollLeft, y: r.top - r0.top + root.scrollTop, w: r.width, h: r.height });
	}
	return m;
}

function ghost(s: Snap, root: HTMLElement) {
	const r0 = root.getBoundingClientRect();
	const left = r0.left + s.x - root.scrollLeft;
	const top = r0.top + s.y - root.scrollTop;
	// Only rows that were inside the visible part of the container get a ghost.
	if (top + s.h < r0.top || top > r0.bottom) return;
	const g = s.el.cloneNode(true) as HTMLElement;
	g.removeAttribute(ATTR);
	// the ghost is only a picture: no test ids, ids or links that could be mistaken for the real row
	for (const el of [g, ...g.querySelectorAll<HTMLElement>("[data-testid],[id],a,button")]) {
		el.removeAttribute("data-testid");
		el.removeAttribute("id");
		el.removeAttribute("href");
		el.setAttribute("tabindex", "-1");
	}
	g.setAttribute("aria-hidden", "true");
	g.setAttribute("inert", "");
	g.setAttribute("data-flip-ghost", "");
	Object.assign(g.style, { position: "fixed", left: `${left}px`, top: `${top}px`, width: `${s.w}px`, height: `${s.h}px`, margin: "0", pointerEvents: "none", zIndex: "40" });
	document.body.appendChild(g);
	const a = g.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-8px)" }], { duration: DURATION * 0.7, easing: "ease-out", fill: "forwards" });
	a.onfinish = a.oncancel = () => g.remove();
}

/**
 * `signature` must change exactly when the list's order / membership changes (not on every poll). Positions are re-read after every
 * render and after every CSS transition inside the container, so the "first" position is always where the row really was.
 */
export function useFlip(ref: RefObject<HTMLElement | null>, signature: string, enabled: boolean) {
	const prev = useRef<Map<string, Snap>>(new Map());
	const lastSig = useRef<string | null>(null);
	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		const next = measure(root);
		const before = prev.current;
		prev.current = next;
		const changed = lastSig.current !== null && lastSig.current !== signature;
		lastSig.current = signature;
		if (!changed || !enabled || typeof Element.prototype.animate !== "function") return;
		for (const [id, now] of next) {
			const was = before.get(id);
			if (!was) {
				now.el.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], { duration: DURATION, easing: EASING });
				continue;
			}
			const dx = was.x - now.x;
			const dy = was.y - now.y;
			if (Math.abs(dy) < THRESHOLD && Math.abs(dx) < THRESHOLD) continue;
			now.el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: DURATION, easing: EASING });
		}
		for (const [id, was] of before) if (!next.has(id)) ghost(was, root);
	});
	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		const resnap = () => {
			prev.current = measure(root);
		};
		root.addEventListener("transitionend", resnap);
		return () => root.removeEventListener("transitionend", resnap);
	}, [ref]);
}
