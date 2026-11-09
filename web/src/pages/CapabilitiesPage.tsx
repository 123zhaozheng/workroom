// 能力: skills (prompt / context-only / executable, each with its dependencies) and connectors (MCP) with
// honest connection state (可用 / 需重连 / 无权限 / 出错 / 未检查 / 已停用).
import { Plug, Sparkles } from "lucide-react";
import { useSearchParams } from "react-router";
import type { ConnectorListResponse, ConnectorStatus, SkillKind, SkillListResponse } from "@shared/files";
import { useApi } from "@/lib/useApi";
import { TopBar } from "@/components/shell/AppShell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge, Blocked, EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";

const KIND: Record<SkillKind, { label: string; hint: string }> = {
	prompt: { label: "提示词预设", hint: "可复用的指令模板，不执行任何代码" },
	context: { label: "上下文技能", hint: "只向助手提供说明（SKILL.md），不执行代码" },
	executable: { label: "可执行技能", hint: "包含脚本与资源，在云端沙箱中执行，需要授权" },
};
const CSTATUS: Record<ConnectorStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
	ready: { label: "可用", tone: "success" },
	needs_reconnect: { label: "需要重新连接", tone: "warning" },
	unauthorized: { label: "凭据被拒绝", tone: "danger" },
	error: { label: "连接出错", tone: "danger" },
	unchecked: { label: "尚未检查", tone: "neutral" },
	disabled: { label: "已停用", tone: "neutral" },
};

export default function CapabilitiesPage() {
	const [sp, setSp] = useSearchParams();
	const tab = sp.get("tab") ?? "skills";
	const skills = useApi<SkillListResponse>("/skills");
	const conns = useApi<ConnectorListResponse>("/connectors");
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>
					<PageHeader title="能力" description="助手可以使用的技能与外部连接。对话中通过输入框引用，不需要在这里逐个开启工作流。" />
					<Tabs value={tab} onValueChange={(v) => setSp({ tab: v })}>
						<TabsList className="mb-5">
							<TabsTrigger value="skills">
								<Sparkles />
								技能
							</TabsTrigger>
							<TabsTrigger value="connectors">
								<Plug />
								连接
							</TabsTrigger>
						</TabsList>
						<TabsContent value="skills">
							<Loadable state={skills} what="技能" need="D 组：GET /api/skills">
								{(skills.data?.skills ?? []).length === 0 ? (
									<EmptyState icon={<Sparkles />} title="还没有技能" />
								) : (
									<div className="space-y-2">
										{skills.data!.skills.map((s) => {
											const v = s.versions?.find((x) => x.versionNo === (s.install?.effectiveVersionNo ?? s.latestVersionNo));
											return (
												<div key={s.id} data-testid="skill" className="rounded-xl border border-border bg-surface p-3">
													<div className="flex flex-wrap items-center gap-2">
														<span className="font-medium">{s.name}</span>
														<Badge title={KIND[s.kind].hint}>{KIND[s.kind].label}</Badge>
														<Badge>{s.scope === "org" ? "企业" : "个人"}</Badge>
														<span className="flex-1" />
														{s.install ? (
															<Badge tone={s.install.enabled ? "success" : "neutral"}>
																{s.install.enabled ? "已启用" : "已停用"} · v{s.install.effectiveVersionNo}
																{s.install.pinnedVersionNo !== null ? "（固定）" : "（跟随最新）"}
															</Badge>
														) : (
															<Badge>未安装</Badge>
														)}
													</div>
													{v?.description ? <p className="mt-1 text-[13px] text-fg-muted">{v.description}</p> : null}
													{v && (v.requiredTools.length || v.requiredPermissions.length) ? (
														<p className="mt-1 text-xs text-fg-subtle">
															依赖：{[...v.requiredTools.map((t) => `工具 ${t}`), ...v.requiredPermissions].join("、")}
														</p>
													) : null}
												</div>
											);
										})}
									</div>
								)}
							</Loadable>
						</TabsContent>
						<TabsContent value="connectors">
							<Loadable state={conns} what="连接" need="D 组：GET /api/connectors">
								{conns.data ? (
									<div className="space-y-2">
										{conns.data.secretStorage === "unavailable" ? <Blocked title="凭据存储不可用">服务端未配置加密密钥（WORKROOM_SECRET_KEY），需要密钥的连接无法保存。</Blocked> : null}
										{conns.data.connectors.length === 0 ? <EmptyState icon={<Plug />} title="还没有连接" /> : null}
										{conns.data.connectors.map((c) => {
											const st = CSTATUS[c.status];
											return (
												<div key={c.id} data-testid="connector" className="rounded-xl border border-border bg-surface p-3">
													<div className="flex flex-wrap items-center gap-2">
														<span className="font-medium">{c.name}</span>
														<Badge>{c.scope === "system" ? "系统" : "个人"}</Badge>
														<span className="flex-1" />
														{c.access === "forbidden" ? <Badge tone="danger">无权限{c.accessReason ? `：${c.accessReason}` : ""}</Badge> : null}
														<Badge tone={st.tone}>{st.label}</Badge>
													</div>
													{c.statusDetail ? <p className="mt-1 text-xs text-fg-muted">{c.statusDetail}</p> : null}
													{c.tools.length ? (
														<p className="mt-1 text-xs text-fg-subtle">
															工具：{c.tools.map((t) => `${t.tool}${t.policy === "write" ? "（写操作，需确认）" : ""}`).join("、")}
														</p>
													) : null}
												</div>
											);
										})}
										{conns.data.blocked.map((b) => (
											<Blocked key={b.kind} title={`${b.kind}：未连接`}>
												{b.reason}
											</Blocked>
										))}
									</div>
								) : null}
							</Loadable>
						</TabsContent>
					</Tabs>
				</Page>
			</div>
		</div>
	);
}
