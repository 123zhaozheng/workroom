// RBAC gates for sandbox-related capabilities (permission ids from shared/permissions.ts): `sandbox.use` (execute code, workspace writes,
// code mode), `sandbox.browser` (server-side browser tools), `sandbox.policy.manage` (driver settings).
// (`sandbox.network` was retired in round 9: Workroom has no sandbox network policy; the id stays in the catalog for one release as a no-op.)
// Without the authz service (unit harnesses) nothing extra is enforced; with it, a missing permission is refused with a 403 that names it.
import type { AppContext, Principal } from "../../core/contracts.ts";
import { HttpError } from "../../core/http.ts";

export type SandboxPermission = "sandbox.use" | "sandbox.browser" | "sandbox.policy.manage";
const LABEL: Record<SandboxPermission, string> = { "sandbox.use": "使用沙箱", "sandbox.browser": "使用浏览器工具", "sandbox.policy.manage": "管理沙箱与工具策略" };

/** Permission needed to call a tool by name (undefined: no sandbox permission involved). */
export function permissionForTool(name: string): SandboxPermission | undefined {
	if (name.startsWith("sandbox_") || name === "codemode" || name === "code_run" || name === "exec") return "sandbox.use";
	if (name === "browse" || name.startsWith("browser_")) return "sandbox.browser";
	return undefined;
}

export async function hasPermission(ctx: AppContext, p: Principal, perm: SandboxPermission): Promise<boolean> {
	if (!ctx.services.has("authz")) return true;
	try {
		return await ctx.services.get("authz").has(p, perm);
	} catch {
		return false;
	}
}

export async function requirePermission(ctx: AppContext, p: Principal, perm: SandboxPermission): Promise<void> {
	if (!(await hasPermission(ctx, p, perm))) throw new HttpError(403, "forbidden", `没有权限：${LABEL[perm]}（${perm}）。请联系组织管理员。`);
}
