// Project override of the execution location. The server says whether the organisation allows it and which locations are enabled;
// project owners only. The server enforces both.
import { useState } from "react";
import { errorText, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

interface Choice {
	provider: string | null;
	allowed: boolean;
	options: { id: string; label: string; enabled: boolean }[];
}

export function SandboxPicker({ projectId }: { projectId: string }) {
	const res = useApi<Choice>(`/projects/${projectId}/sandbox-provider`);
	const [err, setErr] = useState<string>();
	const [ok, setOk] = useState(false);
	if (!res.data?.allowed) return null;
	const change = async (v: string) => {
		setErr(undefined);
		setOk(false);
		try {
			await put(`/projects/${projectId}/sandbox-provider`, { provider: v === "" ? null : v });
			setOk(true);
			res.reload();
		} catch (e) {
			setErr(errorText(e));
		}
	};
	return (
		<section data-testid="project-sandbox" className="mb-8 rounded-xl border border-border bg-surface p-4">
			<Label htmlFor="project-sandbox-select">代码运行位置</Label>
			<Select id="project-sandbox-select" data-testid="project-sandbox-select" value={res.data.provider ?? ""} onChange={(e) => void change(e.target.value)} className="w-56">
				<option value="">跟随组织默认</option>
				<option value="local">本机沙箱</option>
				{res.data.options.map((o) => (
					<option key={o.id} value={o.id} disabled={!o.enabled}>
						{o.label}
						{o.enabled ? "" : "（未启用）"}
					</option>
				))}
			</Select>
			<p className="mt-1 text-xs text-fg-muted">远程位置的数据可能离开组织。</p>
			{err ? <p role="alert" className="mt-2 rounded-lg bg-danger-soft px-3 py-1.5 text-sm text-danger">{err}</p> : ok ? <p role="status" className="mt-2 text-sm text-success">已保存</p> : null}
		</section>
	);
}
