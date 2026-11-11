// Project override of the execution location. Shown to project owners only when the organisation allows it; the server enforces both.
import { useState } from "react";
import type { SandboxSelectionPolicyDTO } from "@shared/sandbox";
import { errorText, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import type { Project } from "@/lib/types";
import { Label, Select } from "@/components/ui/input";

export function SandboxPicker({ project, onChanged }: { project: Project; onChanged: () => void }) {
	const policy = useApi<SandboxSelectionPolicyDTO>("/sandbox/provider-policy");
	const [err, setErr] = useState<string>();
	const [ok, setOk] = useState(false);
	if (!policy.data?.allowProjectOverride) return null;
	const change = async (v: string) => {
		setErr(undefined);
		setOk(false);
		try {
			await put(`/projects/${project.id}/sandbox-provider`, { provider: v === "" ? null : v });
			setOk(true);
			onChanged();
		} catch (e) {
			setErr(errorText(e));
		}
	};
	return (
		<section data-testid="project-sandbox" className="mb-8 rounded-xl border border-border bg-surface p-4">
			<Label htmlFor="project-sandbox-select">代码运行位置</Label>
			<Select id="project-sandbox-select" data-testid="project-sandbox-select" value={project.sandboxProvider ?? ""} onChange={(e) => void change(e.target.value)} className="w-56">
				<option value="">跟随组织默认</option>
				<option value="local">本机沙箱</option>
				<option value="opensandbox">OpenSandbox</option>
				<option value="e2b">E2B</option>
				<option value="daytona">Daytona</option>
			</Select>
			<p className="mt-1 text-xs text-fg-muted">只能选择管理员已启用的位置。远程位置的数据可能离开组织。</p>
			{err ? <p role="alert" className="mt-2 rounded-lg bg-danger-soft px-3 py-1.5 text-sm text-danger">{err}</p> : ok ? <p role="status" className="mt-2 text-sm text-success">已保存</p> : null}
		</section>
	);
}
