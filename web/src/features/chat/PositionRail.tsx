// Position rail for long conversations: a slim column of small ticks at the right edge of the message area, one per question (user turn).
//  · the tick of the turn being read is longer and darker (IntersectionObserver over the turns' anchors, state batched with rAF);
//  · hover / keyboard focus shows a small preview (question + start of the answer); click / Enter scrolls there (instant when motion is reduced);
//  · keyboard: Tab reaches the rail (one tab stop), ↑ ↓ Home End move between ticks; each tick has an aria-label "第 N 轮：…";
//  · touch: a tap shows the preview, a second tap on the same tick (or the 跳转 button in the preview) scrolls;
//  · > MAX_TICKS turns (or not enough height) are bucketed so the rail never grows past the screen.
// Rendered only from MIN_TURNS turns on.
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useMedia } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { bucketize } from "./railBuckets";

export interface RailItem {
	/** Entry id of the user message: the DOM anchor is [data-entry-id="id"]. */
	id: number;
	question: string;
	answer: string;
}

export const MIN_TURNS = 4;
export const MAX_TICKS = 120;
const PITCH = 8; // px per tick (fine pointer)
const PITCH_TOUCH = 24; // WCAG 2.5.8: touch targets at least 24 px; long chats bucket ticks to fit

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function PositionRailImpl({ items, scroller, reduced }: { items: readonly RailItem[]; scroller: RefObject<HTMLElement | null>; reduced: boolean }) {
	const n = items.length;
	const railRef = useRef<HTMLElement>(null);
	const [capacity, setCapacity] = useState(MAX_TICKS);
	const [current, setCurrent] = useState(n - 1);
	const [focusIdx, setFocusIdx] = useState<number | null>(null); // roving tab stop / keyboard focus
	const [hoverIdx, setHoverIdx] = useState<number | null>(null);
	const [touchIdx, setTouchIdx] = useState<number | null>(null);
	const previewId = useId();
	const coarse = useMedia("(pointer: coarse)");
	const pitch = coarse ? PITCH_TOUCH : PITCH;

	// ---- how many ticks fit: bucket when more turns than that ----
	useLayoutEffect(() => {
		const host = scroller.current;
		if (!host) return;
		const measure = () => setCapacity(Math.max(MIN_TURNS, Math.min(MAX_TICKS, Math.floor((host.clientHeight * 0.8) / pitch))));
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(host);
		return () => ro.disconnect();
	}, [scroller, pitch]);
	const buckets = useMemo(() => bucketize(n, capacity), [n, capacity]);
	const bucketOf = useCallback((turn: number) => buckets.findIndex((b) => turn >= b.from && turn <= b.to), [buckets]);
	const currentBucket = bucketOf(current);

	// ---- which turn is being read ----
	const stateRef = useRef<number[]>([]); // per turn: -1 above the band, 0 inside it, 1 below it
	const rafRef = useRef(0);
	const idsKey = items.map((i) => i.id).join(",");
	useEffect(() => {
		const root = scroller.current;
		if (!root || n === 0) return;
		stateRef.current = new Array(n).fill(1);
		let atBottom = false;
		const flush = () => {
			rafRef.current = 0;
			// the last turn that is above or inside the reading band (the top 15 % of the viewport); at the very bottom, the last turn
			let cur = 0;
			for (let i = 0; i < n; i++) if (stateRef.current[i]! <= 0) cur = i;
			if (atBottom) cur = n - 1;
			setCurrent((c) => (c === cur ? c : cur));
		};
		const schedule = () => {
			if (!rafRef.current) rafRef.current = requestAnimationFrame(flush);
		};
		const index = new Map(items.map((it, i) => [String(it.id), i]));
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					const i = index.get((e.target as HTMLElement).dataset.entryId ?? "");
					if (i === undefined) continue;
					const rb = e.rootBounds;
					stateRef.current[i] = e.isIntersecting ? 0 : rb && e.boundingClientRect.bottom <= rb.top + 1 ? -1 : 1;
				}
				schedule();
			},
			{ root, rootMargin: "0px 0px -85% 0px", threshold: [0, 1] },
		);
		const onScroll = () => {
			const b = root.scrollHeight - root.scrollTop - root.clientHeight < 8;
			if (b !== atBottom) {
				atBottom = b;
				schedule();
			}
		};
		root.addEventListener("scroll", onScroll, { passive: true });
		onScroll();
		const observe = () => {
			for (const it of items) {
				const el = root.querySelector<HTMLElement>(`[data-entry-id="${it.id}"]`);
				if (el) io.observe(el);
			}
		};
		observe();
		// anchors may mount a moment after the items (streaming, earlier messages) — look again once layout settled
		const retry = setTimeout(observe, 400);
		return () => {
			clearTimeout(retry);
			root.removeEventListener("scroll", onScroll);
			io.disconnect();
			if (rafRef.current) cancelAnimationFrame(rafRef.current);
			rafRef.current = 0;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [idsKey, scroller]);
	useEffect(() => setCurrent((c) => Math.min(c, n - 1)), [n]);

	// ---- scroll to a turn ----
	const goTo = useCallback(
		(turn: number) => {
			const root = scroller.current;
			const it = items[turn];
			if (!root || !it) return;
			const el = root.querySelector<HTMLElement>(`[data-entry-id="${it.id}"]`);
			if (!el) return;
			const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 16;
			root.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
			setCurrent(turn);
		},
		[items, reduced, scroller],
	);

	// ---- preview target: keyboard focus > hover > touch ----
	const shown = touchIdx ?? focusIdx ?? hoverIdx;
	const touchMode = coarse && touchIdx !== null && shown === touchIdx;
	const shownBucket = shown !== null ? buckets[shown] : undefined;
	const shownItem = shownBucket ? items[shownBucket.from] : undefined;

	const tickRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const moveFocus = (b: number) => {
		const next = Math.max(0, Math.min(buckets.length - 1, b));
		tickRefs.current[next]?.focus();
	};

	if (n < MIN_TURNS) return null;
	const tabStop = focusIdx ?? (currentBucket >= 0 ? currentBucket : buckets.length - 1);

	return (
		<>
			<nav
				ref={railRef}
				aria-label="对话位置"
				data-testid="position-rail"
				data-ticks={buckets.length}
				data-turns={n}
				data-current={current}
				className="pointer-events-none absolute inset-y-0 right-0.5 z-10 flex w-4 flex-col items-center justify-center"
			>
				<div
					role="group"
					className="pointer-events-auto flex flex-col items-center py-1"
					onMouseLeave={() => setHoverIdx(null)}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown" || e.key === "ArrowRight") {
							e.preventDefault();
							moveFocus((focusIdx ?? tabStop) + 1);
						} else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
							e.preventDefault();
							moveFocus((focusIdx ?? tabStop) - 1);
						} else if (e.key === "Home") {
							e.preventDefault();
							moveFocus(0);
						} else if (e.key === "End") {
							e.preventDefault();
							moveFocus(buckets.length - 1);
						}
					}}
				>
					{buckets.map((b, bi) => {
						const it = items[b.from]!;
						const isCur = bi === currentBucket;
						const label = b.from === b.to ? `第 ${b.from + 1} 轮：${clip(it.question, 60)}` : `第 ${b.from + 1}–${b.to + 1} 轮，从：${clip(it.question, 60)}`;
						return (
							<button
								key={b.from}
								ref={(el) => {
									tickRefs.current[bi] = el;
								}}
								type="button"
								data-testid="rail-tick"
								data-turn={b.from}
								aria-label={label}
								aria-current={isCur ? "step" : undefined}
								aria-describedby={shown === bi ? previewId : undefined}
								tabIndex={bi === tabStop ? 0 : -1}
								onFocus={() => setFocusIdx(bi)}
								onBlur={() => setFocusIdx((f) => (f === bi ? null : f))}
								onMouseEnter={() => setHoverIdx(bi)}
								onClick={() => {
									// touch: first tap previews, second tap goes; mouse / keyboard: go
									if (coarse && touchIdx !== bi) {
										setTouchIdx(bi);
										return;
									}
									setTouchIdx(null);
									goTo(b.from);
								}}
								style={{ height: pitch }}
								className="group/tick flex w-4 shrink-0 items-center justify-center outline-none pointer-coarse:w-6"
							>
								<span
									aria-hidden
									className={cn(
										"block h-0.5 rounded-full transition-[width,background-color] duration-150 group-focus-visible/tick:ring-2 group-focus-visible/tick:ring-ring group-focus-visible/tick:ring-offset-1 group-focus-visible/tick:ring-offset-surface",
										isCur ? "w-3.5 bg-fg" : "w-2 bg-fg-subtle group-hover/tick:w-3 group-hover/tick:bg-fg",
									)}
								/>
							</button>
						);
					})}
				</div>
			</nav>
			{shownItem && shownBucket ? (
				<RailPreview
					id={previewId}
					anchor={tickRefs.current[shown!] ?? railRef.current}
					turn={shownBucket.from}
					last={shownBucket.to}
					item={shownItem}
					touch={touchMode}
					onGo={() => {
						setTouchIdx(null);
						goTo(shownBucket.from);
					}}
					onClose={() => setTouchIdx(null)}
				/>
			) : null}
		</>
	);
}

/** Preview card: fixed next to the tick (portal), clamped into the viewport. */
function RailPreview({ id, anchor, turn, last, item, touch, onGo, onClose }: { id: string; anchor: HTMLElement | null; turn: number; last: number; item: RailItem; touch: boolean; onGo: () => void; onClose: () => void }) {
	const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
	useLayoutEffect(() => {
		if (!anchor) return;
		const r = anchor.getBoundingClientRect();
		const h = 132;
		setPos({ top: Math.max(72, Math.min(window.innerHeight - h - 12, r.top + r.height / 2 - h / 2)), right: Math.max(8, window.innerWidth - r.left + 8) });
	}, [anchor, turn]);
	useEffect(() => {
		if (!touch) return;
		const off = (e: PointerEvent) => {
			if (!(e.target as HTMLElement).closest("[data-testid='rail-preview'],[data-testid='position-rail']")) onClose();
		};
		document.addEventListener("pointerdown", off);
		return () => document.removeEventListener("pointerdown", off);
	}, [touch, onClose]);
	if (!pos) return null;
	return createPortal(
		<div
			id={id}
			data-testid="rail-preview"
			role={touch ? "dialog" : "tooltip"}
			aria-label={touch ? "这一轮的预览" : undefined}
			style={{ top: pos.top, right: pos.right }}
			className={cn("fixed z-50 w-64 max-w-[calc(100vw-48px)] rounded-xl border border-border bg-surface p-3 text-left shadow-pop wr-fade-in", touch ? "" : "pointer-events-none")}
		>
			<p className="mb-1 text-xs text-fg-subtle">{turn === last ? `第 ${turn + 1} 轮` : `第 ${turn + 1}–${last + 1} 轮`}</p>
			<p className="line-clamp-2 break-words text-[13px] font-medium text-fg">{item.question || "（空）"}</p>
			{item.answer ? <p className="mt-1 line-clamp-3 break-words text-[13px] text-fg-muted">{item.answer}</p> : null}
			{touch ? (
				<button type="button" data-testid="rail-go" onClick={onGo} className="mt-2 w-full rounded-lg bg-accent py-1.5 text-sm font-medium text-accent-fg focus-visible:ring-2 focus-visible:ring-ring">
					跳转到这一轮
				</button>
			) : null}
		</div>,
		document.body,
	);
}

const sameItems = (a: readonly RailItem[], b: readonly RailItem[]) => a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.question === b[i]!.question && x.answer === b[i]!.answer);

export const PositionRail = memo(PositionRailImpl, (p, n) => p.reduced === n.reduced && p.scroller === n.scroller && sameItems(p.items, n.items));

/** Build rail items from chat turns without keeping the full texts (the rail re-renders only when these short strings change). */
export function railItemOf(question: string, answer: string | undefined): Omit<RailItem, "id"> {
	return { question: clip(question.replace(/\s+/g, " ").trim(), 200), answer: clip((answer ?? "").replace(/\s+/g, " ").trim(), 160) };
}
