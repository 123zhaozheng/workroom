// Workroom avatar configuration: which open-bot-avatar shape, colors and eye placement an expert wears.
// Pure data + validation, shared by server (validate on save, default for new/legacy experts) and web (render).
//
//   { "shape": "cat", "color": "#f8a01c" }                               preset shape + body color
//   { "shape": "cat", "color": "#f8a01c", "eyeColor": "#151515",
//     "eyes": { "x": 50, "y": 43, "spacing": 17, "scale": 1.1 } }        + eye color / eye placement override
//   { "shape": "custom", "color": "#1f7cf2", "custom": { …open-bot-avatar v1 definition… } }   own geometry
import { GALLERY } from "./gallery.ts";
import { examples } from "./examples.ts";
import { hashString } from "./motion.ts";
import { validateAvatar } from "./validate.ts";
import type { AvatarDefinition, AvatarEyes } from "./types.ts";

export interface AvatarConfig {
	/** A preset id (see AVATAR_PRESETS) or "custom". */
	readonly shape: string;
	/** Body color, #rrggbb. */
	readonly color: string;
	/** Eye color, #rrggbb. Default: near-black, or near-white on a dark body. */
	readonly eyeColor?: string;
	/** Overrides the shape's eye placement (viewBox units, see the open-bot-avatar contract). */
	readonly eyes?: AvatarEyes;
	/** Own geometry for shape "custom" (open-bot-avatar definition v1). */
	readonly custom?: AvatarDefinition;
}

const LABELS: Record<string, string> = {
	book: "书本", brain: "大脑", bull: "公牛", bunny: "兔子", camera: "相机", cat: "猫咪", cloud: "云朵", ghost: "幽灵", magnifier: "放大镜",
	"paint-brush": "画笔", palette: "调色盘", rocket: "火箭", shield: "盾牌", star: "星星", "witch-hat": "巫师帽",
	controller: "手柄", barbell: "杠铃", mug: "马克杯", lightbulb: "灯泡", chat: "对话", sprout: "嫩芽", "watering-can": "水壶",
};

export interface AvatarPreset {
	readonly id: string;
	readonly label: string;
	readonly def: AvatarDefinition;
}
/** The shapes an expert can pick (open-bot-avatar gallery + starters, MIT; see shared/bot-avatar/NOTICE.md). */
export const AVATAR_PRESETS: readonly AvatarPreset[] = [...examples, ...GALLERY].map((def) => ({ id: def.id, label: LABELS[def.id] ?? def.name, def }));
const PRESET_BY_ID = new Map(AVATAR_PRESETS.map((p) => [p.id, p]));

export const AVATAR_COLORS = [
	{ value: "#ff6a1a", name: "橙" },
	{ value: "#f2384b", name: "红" },
	{ value: "#f8a01c", name: "琥珀" },
	{ value: "#1fbf68", name: "绿" },
	{ value: "#14b3a5", name: "青" },
	{ value: "#1f7cf2", name: "蓝" },
	{ value: "#8b5cf6", name: "紫" },
	{ value: "#ec4899", name: "粉" },
	{ value: "#a8693f", name: "棕" },
	{ value: "#7a7a7a", name: "灰" },
	{ value: "#23252a", name: "墨黑" },
] as const;
/** The default look draws from the bright colors only. */
const DEFAULT_COLORS = AVATAR_COLORS.slice(0, 8);

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function hex(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const s = v.trim();
	if (HEX6.test(s)) return s.toLowerCase();
	if (HEX3.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
	return null;
}

/** Stable default look for an id: the same id always gets the same shape and color, on server and client. */
export function defaultAvatarConfig(seed: string): AvatarConfig {
	const shape = AVATAR_PRESETS[hashString(`${seed}:shape`) % AVATAR_PRESETS.length]!;
	const color = DEFAULT_COLORS[hashString(`${seed}:color`) % DEFAULT_COLORS.length]!;
	return { shape: shape.id, color: color.value };
}

/** The product's own bot: the Workroom logo and the assistant when no expert is bound. */
export const BRAND_AVATAR: AvatarConfig = { shape: "chat", color: "#23252a" };

/** Relative luminance 0..1 of a #rrggbb color. */
function luminance(h: string): number {
	const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export const INK_DARK = "#151515";
export const INK_LIGHT = "#f4f4f4";
export const autoEyeColor = (body: string) => (luminance(body) < 0.06 ? INK_LIGHT : INK_DARK);

const EYE_KEYS = ["x", "y", "spacing", "scale"] as const;

export type AvatarConfigResult = { ok: true; value: AvatarConfig } | { ok: false; errors: string[] };

/** Validate (and normalize) untrusted avatar configuration JSON. Unknown fields are rejected. */
export function validateAvatarConfig(input: unknown): AvatarConfigResult {
	const errors: string[] = [];
	if (!isRecord(input)) return { ok: false, errors: ["头像配置必须是 JSON 对象"] };
	for (const k of Object.keys(input)) if (!["shape", "color", "eyeColor", "eyes", "custom"].includes(k)) errors.push(`不支持的字段 "${k}"（可用：shape、color、eyeColor、eyes、custom）`);
	const shape = typeof input.shape === "string" ? input.shape : "";
	const color = hex(input.color);
	if (!color) errors.push("color 必须是 #rrggbb 颜色");
	let eyeColor: string | undefined;
	if (input.eyeColor !== undefined && input.eyeColor !== null) {
		const e = hex(input.eyeColor);
		if (!e) errors.push("eyeColor 必须是 #rrggbb 颜色");
		else eyeColor = e;
	}
	let eyes: AvatarEyes | undefined;
	if (input.eyes !== undefined && input.eyes !== null) {
		const e = input.eyes;
		if (!isRecord(e)) errors.push("eyes 必须是 { x, y, spacing, scale }");
		else {
			const bad = EYE_KEYS.filter((k) => typeof e[k] !== "number" || !Number.isFinite(e[k] as number));
			const extra = Object.keys(e).filter((k) => !(EYE_KEYS as readonly string[]).includes(k));
			if (bad.length || extra.length) errors.push(`eyes 只能包含数值字段 ${EYE_KEYS.join("、")}`);
			else eyes = { x: e.x as number, y: e.y as number, spacing: e.spacing as number, scale: e.scale as number };
		}
	}
	let custom: AvatarDefinition | undefined;
	if (shape === "custom") {
		if (JSON.stringify(input.custom ?? null).length > 8000) errors.push("custom 过大");
		else {
			const v = validateAvatar(input.custom);
			if (!v.ok) errors.push(...v.errors.slice(0, 3).map((m) => `custom：${m}`));
			else custom = v.value;
		}
	} else if (!PRESET_BY_ID.has(shape)) errors.push(`未知造型 "${shape}"（可用：${AVATAR_PRESETS.map((p) => p.id).join("、")}，或 custom）`);
	else if (input.custom !== undefined && input.custom !== null) errors.push("custom 只在 shape 为 custom 时使用");
	if (!errors.length && eyes && shape !== "custom") {
		const v = validateAvatar({ ...PRESET_BY_ID.get(shape)!.def, eyes });
		if (!v.ok) errors.push(...v.errors.slice(0, 2).map((m) => `eyes：${m}`));
	}
	if (errors.length) return { ok: false, errors };
	return { ok: true, value: { shape, color: color!, ...(eyeColor ? { eyeColor } : {}), ...(eyes ? { eyes } : {}), ...(custom ? { custom } : {}) } };
}

export interface ResolvedAvatar {
	readonly def: AvatarDefinition;
	readonly color: string;
	readonly eyeColor: string;
	/** The eye color was chosen explicitly (not derived from the body color). */
	readonly eyeExplicit: boolean;
	/** Equal for equal looks: a cache / change key. */
	readonly key: string;
}
const resolved = new Map<string, ResolvedAvatar>();

/** The renderable look for a stored config; anything missing or broken (legacy rows, old snapshots) falls back to the id's default. */
export function resolveAvatar(config: unknown, seed: string): ResolvedAvatar {
	const cacheKey = `${seed}|${config === undefined || config === null ? "" : JSON.stringify(config)}`;
	const hit = resolved.get(cacheKey);
	if (hit) return hit;
	let cfg: AvatarConfig | undefined;
	if (config !== undefined && config !== null) {
		const v = validateAvatarConfig(config);
		if (v.ok) cfg = v.value;
	}
	cfg ??= defaultAvatarConfig(seed);
	const base = cfg.shape === "custom" ? cfg.custom! : PRESET_BY_ID.get(cfg.shape)!.def;
	const def: AvatarDefinition = cfg.eyes ? { ...base, eyes: { ...cfg.eyes } } : base;
	const out: ResolvedAvatar = { def, color: cfg.color, eyeColor: cfg.eyeColor ?? autoEyeColor(cfg.color), eyeExplicit: !!cfg.eyeColor, key: JSON.stringify([def.id, def.body.path, def.eyes, cfg.color, cfg.eyeColor]) };
	if (resolved.size >= 500) resolved.clear();
	resolved.set(cacheKey, out);
	return out;
}

/** Colors to draw with on a light or dark page: a near-black body would vanish on dark surfaces, so it flips to a light body with dark eyes. */
export function colorsFor(r: ResolvedAvatar, dark: boolean): { color: string; eyeColor: string } {
	if (dark && !r.eyeExplicit && luminance(r.color) < 0.06) return { color: "#ececeb", eyeColor: INK_DARK };
	return { color: r.color, eyeColor: r.eyeColor };
}

/** Plain JSON for the editor's advanced box. */
export const avatarConfigJson = (c: AvatarConfig) => JSON.stringify(c, null, 2);
