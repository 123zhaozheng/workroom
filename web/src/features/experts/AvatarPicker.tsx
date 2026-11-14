// 头像 picker of the expert form: pick a shape and colors (live preview), or edit the avatar JSON directly (same schema the server validates).
import { useState } from "react";
import { AVATAR_COLORS, AVATAR_PRESETS, autoEyeColor, avatarConfigJson, validateAvatarConfig, type AvatarConfig } from "@shared/bot-avatar/config";
import { BotAvatar } from "@/components/BotAvatar";
import { Label, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const EYES = [
	{ value: undefined, label: "自动" },
	{ value: "#151515", label: "深色" },
	{ value: "#f4f4f4", label: "浅色" },
] as const;

export function AvatarPicker({ value, onChange, seed }: { value: AvatarConfig; onChange: (c: AvatarConfig) => void; seed: string }) {
	const [json, setJson] = useState<string | null>(null);
	const [jsonErr, setJsonErr] = useState<string>();
	const set = (patch: Partial<AvatarConfig>) => {
		setJson(null);
		setJsonErr(undefined);
		const next = { ...value, ...patch };
		if (patch.eyeColor === undefined && "eyeColor" in patch) delete (next as { eyeColor?: string }).eyeColor;
		// presets own their eye placement; a custom shape keeps its geometry
		if (patch.shape && patch.shape !== "custom") {
			delete (next as { eyes?: unknown }).eyes;
			delete (next as { custom?: unknown }).custom;
		}
		onChange(next);
	};
	const onJson = (text: string) => {
		setJson(text);
		try {
			const r = validateAvatarConfig(JSON.parse(text));
			if (r.ok) {
				setJsonErr(undefined);
				onChange(r.value);
			} else setJsonErr(r.errors.join("；"));
		} catch {
			setJsonErr("不是有效的 JSON");
		}
	};
	return (
		<div data-testid="avatar-picker" className="rounded-xl border border-border p-3">
			<div className="flex items-start gap-3">
				<div className="flex flex-col items-center gap-1">
					<span className="rounded-xl bg-surface-2 p-2">
						<BotAvatar config={value} seed={seed} size={64} label="头像预览" />
					</span>
				</div>
				<div className="min-w-0 flex-1 space-y-2.5">
					<div>
						<Label className="mb-1 text-xs">造型</Label>
						<div className="flex flex-wrap gap-1" role="radiogroup" aria-label="头像造型">
							{AVATAR_PRESETS.map((p) => {
								const on = value.shape === p.id;
								return (
									<button
										key={p.id}
										type="button"
										role="radio"
										aria-checked={on}
										aria-label={p.label}
										title={p.label}
										data-testid="avatar-shape"
										data-shape={p.id}
										onClick={() => set({ shape: p.id })}
										className={cn("grid size-10 place-items-center rounded-lg border transition-colors", on ? "border-fg bg-surface-2" : "border-transparent hover:bg-surface-2")}
									>
										<BotAvatar config={{ shape: p.id, color: value.color }} seed={seed} size={30} still />
									</button>
								);
							})}
						</div>
					</div>
					<div className="flex flex-wrap items-end gap-x-5 gap-y-2">
						<div>
							<Label className="mb-1 text-xs">颜色</Label>
							<div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="头像颜色">
								{AVATAR_COLORS.map((c) => (
									<button
										key={c.value}
										type="button"
										role="radio"
										aria-checked={value.color === c.value}
										aria-label={c.name}
										title={c.name}
										data-testid="avatar-color"
										data-color={c.value}
										onClick={() => set({ color: c.value })}
										className={cn("size-6 rounded-full border-2 transition-transform hover:scale-110", value.color === c.value ? "border-fg" : "border-transparent ring-1 ring-border")}
										style={{ background: c.value }}
									/>
								))}
							</div>
						</div>
						<div>
							<Label className="mb-1 text-xs">眼睛</Label>
							<div className="flex gap-1" role="radiogroup" aria-label="眼睛颜色">
								{EYES.map((e) => {
									const on = value.eyeColor === e.value;
									return (
										<button
											key={e.label}
											type="button"
											role="radio"
											aria-checked={on}
											data-testid="avatar-eye"
											onClick={() => set({ eyeColor: e.value })}
											className={cn("h-6 rounded-md px-2 text-xs", on ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg-muted hover:bg-surface-3")}
										>
											{e.label}
										</button>
									);
								})}
							</div>
						</div>
					</div>
				</div>
			</div>
			<details className="mt-2.5">
				<summary className="cursor-pointer text-xs text-fg-muted">高级：头像 JSON</summary>
				<Textarea
					data-testid="avatar-json"
					aria-label="头像 JSON"
					rows={5}
					spellCheck={false}
					className="mt-1.5 font-mono text-xs"
					value={json ?? avatarConfigJson(value)}
					onChange={(e) => onJson(e.target.value)}
				/>
				<p className={cn("mt-1 text-xs", jsonErr ? "text-danger" : "text-fg-subtle")} role={jsonErr ? "alert" : undefined}>
					{jsonErr ?? `shape 为预设造型 id，或 custom（自带 open-bot-avatar 造型）；color / eyeColor 为 #rrggbb；可用 eyes 微调眼睛位置。当前眼睛：${value.eyeColor ?? autoEyeColor(value.color)}`}
				</p>
			</details>
		</div>
	);
}
