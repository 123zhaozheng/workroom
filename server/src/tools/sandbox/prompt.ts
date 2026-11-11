// Round 10: the system-prompt section that tells the model where its commands really run (pure rendering; the data comes from Sandbox.promptInfo).
//
// The section is re-rendered before every model request (pi-durable: sections are rendered per request and only a CHANGED text is stored and sent again),
// so it always reflects the CURRENT sandbox channel and working directory: when an admin switches provider or changes the working directory, the next
// request of any existing conversation carries the new text. The text is a pure function of (kind, label, workDir, skillsRoot, usable): stable between
// changes, so provider prompt caches stay warm.
import { LOCAL_WORKDIR } from "./workdir.ts";

export interface SandboxPromptInfo {
	readonly kind: "local" | "remote";
	/** "Daytona", "OpenSandbox（自托管）", "平台内置沙箱（Docker）" … */
	readonly label: string;
	/** Absolute working directory inside the sandbox (cwd of every command). */
	readonly workDir: string;
	/** Absolute directory holding the read-only skills inside the sandbox. */
	readonly skillsRoot: string;
	/** False when the sandbox cannot run commands right now (disabled / unconfigured provider, no local driver). */
	readonly usable: boolean;
	readonly reason?: string;
	/** Round 11 (R5): persistent folders that exist for this actor in this conversation ("project" only when the conversation belongs to a project). */
	readonly stores?: readonly ("memories" | "project")[];
}

export function renderSandboxSection(i: SandboxPromptInfo): string {
	const kind = i.kind === "remote" ? `云端沙箱 ${i.label}（远端；命令不在 Workroom 服务器上运行）` : `${i.label}（在 Workroom 服务器上隔离运行）`;
	if (!i.usable) {
		return [`沙箱环境：${kind}，当前不可用${i.reason ? `：${i.reason}` : ""}。`, "在恢复之前 sandbox_exec 等沙箱工具无法使用：如实告诉用户，不要声称已经执行过命令或生成过文件。"].join("\n");
	}
	const lines = [
		"沙箱环境（sandbox_exec、文件工具与技能脚本的运行位置）：",
		`- 类型：${kind}`,
		`- 工作目录：${i.workDir} —— 每条命令的当前目录（cwd），环境变量 WORKROOM_WORKDIR 也指向它；会话文件都在这里，只有它可写并随会话保存（/tmp 只是临时空间）。命令里优先用相对路径（如 out/report.csv）。`,
		`- 文件工具（sandbox_write_file、sandbox_read_file、sandbox_import、sandbox_publish、skill_manage 的 dir）的路径写相对路径；绝对路径只接受以 ${i.workDir} 开头的${i.workDir === LOCAL_WORKDIR ? "" : "（或兼容旧写法的 /work/…）"}。`,
	];
	if (i.workDir !== LOCAL_WORKDIR) lines.push(`- 不要假设 /work 存在：这个沙箱里没有它，请使用 ${i.workDir} 或相对路径。`);
	if (i.kind === "remote") lines.push("- 沙箱空闲时会被暂停或回收，会话文件会保留；恢复后之前装的依赖或后台进程可能需要重装、重启。");
	if (i.stores?.includes("memories")) lines.push("- memories/ 会永久保存，并在这位用户的所有会话里都能看到：值得长期记住的笔记和资料写在这里；其余文件只属于当前会话。");
	if (i.stores?.includes("project")) lines.push("- project/ 是本项目所有会话共享的目录，也会永久保存。");
	lines.push(`- 技能目录（只读）：${i.skillsRoot}/<技能名>/，加载技能后才会出现；不要修改它，也不要把文件写到那里。`);
	return lines.join("\n");
}
