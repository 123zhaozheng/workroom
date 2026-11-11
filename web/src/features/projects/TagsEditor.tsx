// Tag editor shown in a popover next to a conversation row. Chips with remove buttons, an input (Enter / comma adds), 保存 writes the
// whole set through PUT …/tags; the server normalises again (trim, ≤ 24 chars, ≤ 8 tags).
import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { errorText } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { cleanTags, TAG_MAX, TAGS_MAX } from "./model";

export function TagsEditor({ initial, onSave, onCancel }: { initial: readonly string[]; onSave: (tags: string[]) => Promise<unknown>; onCancel: () => void }) {
	const [tags, setTags] = useState<string[]>([...initial]);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const ref = useRef<HTMLInputElement>(null);
	const full = tags.length >= TAGS_MAX;
	const commit = (raw: string) => {
		const next = cleanTags([...tags, ...raw.split(/[,，]/)]);
		setTags(next);
		setDraft("");
	};
	return (
		<form
			className="w-72 space-y-2 p-2"
			data-testid="tags-editor"
			onSubmit={async (e) => {
				e.preventDefault();
				const final = cleanTags([...tags, ...draft.split(/[,，]/)]);
				setBusy(true);
				setErr(undefined);
				try {
					await onSave(final);
				} catch (er) {
					setErr(errorText(er));
					setBusy(false);
				}
			}}
		>
			<div className="text-sm font-medium">标签</div>
			<ul aria-label="已有标签" className="flex min-h-6 flex-wrap gap-1.5">
				{tags.length === 0 ? <li className="text-xs text-fg-muted">还没有标签</li> : null}
				{tags.map((t) => (
					<li key={t} data-testid="tag-chip" className="inline-flex h-6 items-center gap-0.5 rounded-md bg-surface-2 pl-2 pr-0.5 text-xs">
						{t}
						<button type="button" aria-label={`移除标签 ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))} className="inline-flex size-5 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring">
							<X className="size-3" />
						</button>
					</li>
				))}
			</ul>
			<div className="flex gap-1.5">
				<Input
					ref={ref}
					autoFocus
					value={draft}
					maxLength={TAG_MAX + 1}
					disabled={full}
					placeholder={full ? `最多 ${TAGS_MAX} 个标签` : "输入后按 Enter 添加"}
					aria-label="新标签"
					data-testid="tag-input"
					className="h-8"
					onChange={(e) => (/[,，]$/.test(e.target.value) ? commit(e.target.value) : setDraft(e.target.value))}
					onKeyDown={(e) => {
						if (e.key === "Enter" && draft.trim()) {
							e.preventDefault();
							commit(draft);
						} else if (e.key === "Backspace" && !draft && tags.length) setTags(tags.slice(0, -1));
					}}
				/>
				<Button type="button" size="icon" variant="secondary" aria-label="添加标签" disabled={!draft.trim() || full} onClick={() => commit(draft)}>
					<Plus />
				</Button>
			</div>
			{err ? (
				<p role="alert" className="text-xs text-danger">
					{err}
				</p>
			) : null}
			<div className="flex justify-end gap-2">
				<Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
					取消
				</Button>
				<Button type="submit" size="sm" variant="primary" disabled={busy} data-testid="tags-save">
					{busy ? <Spinner className="text-accent-fg" /> : null}保存
				</Button>
			</div>
		</form>
	);
}
