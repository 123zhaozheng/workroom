import { useState } from "react";
import { errorText } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { createProject } from "./actions";
import type { UiProject } from "./model";

/** Creates a container project: a named group for conversations (they stay in their owners' personal spaces). */
export function NewProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (p: UiProject) => void }) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) setErr(undefined);
				onOpenChange(o);
			}}
		>
			<DialogContent title="新建项目">
				<form
					onSubmit={async (e) => {
						e.preventDefault();
						if (busy) return;
						setBusy(true);
						setErr(undefined);
						try {
							const p = await createProject(name.trim());
							setName("");
							onOpenChange(false);
							onCreated(p);
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
						<Input id="pname" data-testid="new-project-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required autoFocus />
					</div>
					{err ? (
						<p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
							{err}
						</p>
					) : null}
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="submit" variant="primary" data-testid="new-project-create" disabled={busy || !name.trim()}>
							创建
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
