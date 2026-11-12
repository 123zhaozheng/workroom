// The card illustration of the 文件库 overview: a soft tray with 1–4 file "papers" fanned out of it. Pure CSS (design tokens, so dark
// mode follows): a paper is a mini page with the file name, a type badge and a faint skeleton of the content (text lines, a mini
// table, a chart, a diagram, a slide; real thumbnails for images). Decorative only — the card around it carries the accessible name.
import { useState } from "react";
import type { LibItemDTO } from "@shared/files";
import { fileIcon } from "@/features/chat/Cards";
import { extOf, kindOf } from "./fileKinds";

interface Slot {
	x: number;
	w: number;
	h: number;
	r: number;
}
/** Paper slots per count (x = centre in %, w in %, h in px, r = tilt in deg) and the order items fill them: newest in the middle. */
const LAYOUT: Record<number, { slots: Slot[]; order: number[] }> = {
	1: { slots: [{ x: 50, w: 50, h: 140, r: -2 }], order: [0] },
	2: { slots: [{ x: 36, w: 44, h: 128, r: -6 }, { x: 64, w: 44, h: 138, r: 4 }], order: [1, 0] },
	3: { slots: [{ x: 24, w: 37, h: 120, r: -8 }, { x: 50, w: 42, h: 148, r: 0 }, { x: 77, w: 37, h: 124, r: 7 }], order: [1, 0, 2] },
	4: { slots: [{ x: 17, w: 33, h: 112, r: -9 }, { x: 39, w: 36, h: 142, r: -3 }, { x: 62, w: 36, h: 138, r: 3 }, { x: 84, w: 33, h: 116, r: 9 }], order: [1, 2, 0, 3] },
};

const colorOf = (name: string, mime: string) => {
	const ext = extOf(name);
	if (mime.startsWith("image/")) return "var(--kind-image)";
	if (ext === "pdf") return "var(--kind-pdf)";
	if (["xls", "xlsx", "csv", "tsv"].includes(ext)) return "var(--kind-xls)";
	if (["ppt", "pptx"].includes(ext)) return "var(--kind-ppt)";
	if (["doc", "docx"].includes(ext)) return "var(--kind-doc)";
	if (["html", "js", "ts", "py", "json", "css"].includes(ext)) return "var(--kind-code)";
	return "var(--kind-text)";
};
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const tint = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

const LINES = ["92%", "78%", "86%", "60%", "70%"];
function Lines({ n = 5, from = 0 }: { n?: number; from?: number }) {
	return (
		<div className="space-y-[3px]">
			{Array.from({ length: n }, (_, i) => (
				<div key={i} className="h-[3px] rounded-full bg-fg/10" style={{ width: LINES[(i + from) % LINES.length] }} />
			))}
		</div>
	);
}

function Body({ item, color }: { item: LibItemDTO; color: string }) {
	const kind = kindOf(item.name, item.mime);
	const [broken, setBroken] = useState(false);
	if (kind === "image" && !broken)
		return <img src={`${item.downloadUrl}?v=${encodeURIComponent(item.etag.slice(0, 16))}`} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} className="mt-1 min-h-0 w-full flex-1 rounded-[3px] bg-surface-2 object-cover" />;
	if (kind === "sheet")
		return (
			<div className="mt-1.5 grid grid-cols-4 gap-px overflow-hidden rounded-[3px] border border-border bg-border">
				{Array.from({ length: 20 }, (_, i) => (
					<div key={i} className="h-[7px] bg-surface" style={i < 4 ? { background: tint(color, 28) } : i % 4 === 0 ? { background: "var(--surface-2)" } : undefined} />
				))}
			</div>
		);
	if (kind === "slide")
		return (
			<>
				<div className="relative mt-1.5 h-[52px] overflow-hidden rounded-[3px]" style={{ background: `linear-gradient(135deg, ${tint(color, 26)}, ${tint(color, 6)})` }}>
					<svg viewBox="0 0 100 40" preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-3/5 w-full">
						<path d="M0 40V26C18 12 30 30 50 20S82 8 100 22V40Z" fill={tint(color, 22)} />
					</svg>
				</div>
				<div className="mt-1.5">
					<Lines n={2} />
				</div>
			</>
		);
	const v = hash(item.name) % 3;
	return (
		<div className="mt-1.5 space-y-1.5">
			<div className="h-[3px] w-[55%] rounded-full" style={{ background: tint(color, 45) }} />
			<Lines n={v === 0 ? 6 : 3} from={hash(item.name) % 4} />
			{v === 1 ? (
				<div className="flex h-7 items-end gap-[3px]">
					{[40, 62, 48, 80, 100].map((h, i) => (
						<div key={i} className="w-full rounded-t-[1.5px]" style={{ height: `${h}%`, background: tint(color, 22 + i * 6) }} />
					))}
				</div>
			) : v === 2 ? (
				<div className="flex items-center gap-1">
					<div className="h-4 w-1/3 rounded-[3px] border" style={{ borderColor: tint(color, 50), background: tint(color, 12) }} />
					<div className="h-px flex-1 bg-fg/20" />
					<div className="h-4 w-1/3 rounded-[3px] border" style={{ borderColor: tint(color, 50), background: tint(color, 12) }} />
				</div>
			) : null}
		</div>
	);
}

function Paper({ item, slot, z }: { item: LibItemDTO; slot: Slot; z: number }) {
	const Icon = fileIcon(item.name, item.mime);
	const color = colorOf(item.name, item.mime);
	return (
		<div className="absolute" style={{ left: `${slot.x}%`, width: `${slot.w}%`, height: slot.h, bottom: 24, zIndex: z, transform: `translateX(-50%) rotate(${slot.r}deg)`, transformOrigin: "50% 100%" }}>
			<div className="flex h-full flex-col overflow-hidden rounded-[7px] border border-border bg-surface p-1.5 shadow-[0_3px_10px_-2px_rgb(20_20_22/0.2)] motion-safe:transition-transform motion-safe:duration-200 group-focus-within:-translate-y-1.5 group-hover:-translate-y-1.5">
				<div className="flex items-start gap-1">
					<span className="mt-px flex size-[14px] shrink-0 items-center justify-center rounded-[3px]" style={{ background: tint(color, 16), color }}>
						<Icon className="size-[10px]" strokeWidth={2} />
					</span>
					<span className="line-clamp-2 min-w-0 break-all text-[10px] font-semibold leading-[1.15] text-fg">{item.name}</span>
				</div>
				<Body item={item} color={color} />
			</div>
		</div>
	);
}

export function FileTray({ items }: { items: LibItemDTO[] }) {
	const shown = items.slice(0, 4);
	const layout = LAYOUT[Math.max(1, shown.length)]!;
	const mid = (shown.length - 1) / 2;
	return (
		<div aria-hidden className="relative mx-auto h-[192px] w-full max-w-[380px] select-none overflow-visible">
			<div className="absolute inset-x-[4%] bottom-[14px] h-[34px] rounded-[14px] bg-surface-3" />
			{shown.map((item, i) => {
				const slotIdx = layout.order[i]!;
				return <Paper key={item.fileId} item={item} slot={layout.slots[slotIdx]!} z={10 - Math.round(Math.abs(slotIdx - mid) * 2)} />;
			})}
			<div className="absolute inset-x-[2%] bottom-0 z-20 h-[44px] rounded-b-[24px] rounded-t-[8px] border border-border bg-gradient-to-b from-surface via-surface-2 to-surface-3 shadow-[0_10px_16px_-8px_rgb(40_34_20/0.32),inset_0_1px_0_rgb(255_255_255/0.5)]" />
		</div>
	);
}
