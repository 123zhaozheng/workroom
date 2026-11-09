import { useState } from "react";
import { errorText, post } from "@/lib/api";
import type { Project } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlay";

export function NewProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (p: Project) => void }) {
	const [name, setName] = useState("");
	const [desc, setDesc] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="新建项目" description="项目有独立的对话、文件和知识空间，可以邀请成员并设置角色。">
				<form
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						setErr(undefined);
						try {
							const r = await post<{ project: Project }>("/projects", { name, description: desc });
							setName("");
							setDesc("");
							onOpenChange(false);
							onCreated(r.project);
						} catch (e) {
							setErr(errorText(e));
						} finally {
							setBusy(false);
						}
					}}
					className="space-y-3"
				>
					<div>
						<Label htmlFor="pname">名称</Label>
						<Input id="pname" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
					</div>
					<div>
						<Label htmlFor="pdesc">说明（可选）</Label>
						<Textarea id="pdesc" value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} />
					</div>
					{err ? <p className="text-[13px] text-danger">{err}</p> : null}
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="submit" variant="primary" disabled={busy || !name.trim()}>
							创建
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
