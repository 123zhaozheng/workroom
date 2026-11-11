// The sidebar's scrolling list: 星标 · 项目 (tree) · 最近对话. Data: GET /projects, GET /conversations (summaries carry projectId),
// GET /conversation-meta (per-user star, tags). Rows move with FLIP (lib/useFlip) when a conversation is starred / moved / reordered /
// added / removed; groups open and close with a height transition (Collapse). Open projects are remembered per user in localStorage.
import { ChevronRight, Plus, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { ConversationSummary } from "@shared/chat";
import type { ConversationMetaDTO } from "@shared/round9";
import { errorText } from "@/lib/api";
import { useSession } from "@/lib/session";
import { usePrefs } from "@/lib/prefs";
import { useApi } from "@/lib/useApi";
import { useFlip } from "@/lib/useFlip";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/overlay";
import { CONV_EVENT, convKey, isLegacy, isOwnContainer, isSharedToMe, metaMap, NO_META, normalizeProject, PROJECT_EVENT, type ConvMeta, type UiProject } from "@/features/projects/model";
import { NewProjectDialog } from "@/features/projects/NewProjectDialog";
import { Collapse } from "./Collapse";
import { ConversationRow } from "./ConversationRow";
import { ProjectRow } from "./ProjectRow";
import type { TreeCtx } from "./treeTypes";

/** Conversations shown under one project before "查看全部". */
const PER_PROJECT = 10;

function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}
function writeJson(key: string, v: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(v));
	} catch {
		/* storage unavailable: the choice lasts until reload */
	}
}

export function SidebarTree({ onNavigate }: { onNavigate?: () => void }) {
	const { me } = useSession();
	const { motionReduced } = usePrefs();
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const projectsRes = useApi<{ projects: unknown[] }>("/projects", { pollMs: 30000 });
	const convsRes = useApi<{ conversations: ConversationSummary[] }>("/conversations?limit=120", { pollMs: 8000 });
	const metaRes = useApi<{ items: ConversationMetaDTO[] }>("/conversation-meta", { pollMs: 8000 });
	const [newProject, setNewProject] = useState(false);
	const [notice, setNotice] = useState<string>();
	const scroller = useRef<HTMLDivElement>(null);

	const reloadProjects = projectsRes.reload;
	const reloadConvs = convsRes.reload;
	const reloadMeta = metaRes.reload;
	const reload = useCallback(() => {
		reloadProjects();
		reloadConvs();
		reloadMeta();
	}, [reloadProjects, reloadConvs, reloadMeta]);
	// Refresh whenever the person moves between conversations, and when something reports a change.
	useEffect(() => {
		reloadConvs();
		reloadMeta();
	}, [pathname, reloadConvs, reloadMeta]);
	useEffect(() => {
		const onConv = () => {
			reloadConvs();
			reloadMeta();
		};
		const onProj = () => {
			reloadProjects();
			reloadConvs();
		};
		window.addEventListener(CONV_EVENT, onConv);
		window.addEventListener(PROJECT_EVENT, onProj);
		return () => {
			window.removeEventListener(CONV_EVENT, onConv);
			window.removeEventListener(PROJECT_EVENT, onProj);
		};
	}, [reloadConvs, reloadMeta, reloadProjects]);

	// ---- remembered open state (per user) ----
	const uid = me?.userId ?? "anon";
	const openKey = `wr.sidebar.${uid}.projects`;
	const [openMap, setOpenMap] = useState<Record<string, boolean>>(() => readJson(openKey, {}));
	const setOpen = useCallback(
		(id: string, v: boolean) =>
			setOpenMap((m) => {
				if ((m[id] ?? false) === v) return m;
				const n = { ...m, [id]: v };
				writeJson(openKey, n);
				return n;
			}),
		[openKey],
	);
	const sectionKey = (name: string) => `wr.sidebar.${uid}.section.${name}`;
	const [sections, setSections] = useState<Record<string, boolean>>(() => ({ projects: readJson(sectionKey("projects"), true), recent: readJson(sectionKey("recent"), true), starred: readJson(sectionKey("starred"), true) }));
	const toggleSection = (name: string) =>
		setSections((s) => {
			const n = { ...s, [name]: !s[name] };
			writeJson(sectionKey(name), n[name]);
			return n;
		});

	// ---- derived lists ----
	const projects = useMemo(() => (projectsRes.data?.projects ?? []).map(normalizeProject), [projectsRes.data]);
	const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
	const meta = useMemo(() => metaMap(metaRes.data?.items), [metaRes.data]);
	const metaOf = useCallback((c: ConversationSummary): ConvMeta => meta.get(convKey(c)) ?? NO_META, [meta]);
	const convs = useMemo(() => (convsRes.data?.conversations ?? []).filter((c) => c.kind !== "subagent" && !c.archived), [convsRes.data]);

	const groups = useMemo(() => {
		const starred: ConversationSummary[] = [];
		const recent: ConversationSummary[] = [];
		const byProject = new Map<string, ConversationSummary[]>();
		for (const c of convs) {
			if (metaOf(c).starred) starred.push(c);
			else if (c.projectId && projectById.has(c.projectId)) byProject.set(c.projectId, [...(byProject.get(c.projectId) ?? []), c]);
			else recent.push(c);
		}
		const own = projects.filter((p) => isOwnContainer(p));
		const legacy = projects.filter((p) => isLegacy(p));
		const shared = projects.filter((p) => isSharedToMe(p));
		return { starred, recent, byProject, own, legacy, shared };
	}, [convs, metaOf, projectById, projects]);

	const signature = useMemo(
		() =>
			[
				`s:${groups.starred.map(convKey).join(",")}`,
				...[...groups.own, ...groups.legacy, ...groups.shared].map((p) => `p${p.id}:${(groups.byProject.get(p.id) ?? []).slice(0, PER_PROJECT).map(convKey).join(",")}`),
				`r:${groups.recent.map(convKey).join(",")}`,
			].join("|"),
		[groups],
	);
	useFlip(scroller, signature, !motionReduced);

	// The project that holds the conversation on screen opens by itself.
	const activeConv = useMemo(() => {
		const m = /^\/c\/([^/]+)\/(\d+)/.exec(pathname);
		return m ? convs.find((c) => c.spaceId === m[1] && c.conversationId === Number(m[2])) : undefined;
	}, [pathname, convs]);
	const activeProject = activeConv?.projectId;
	useEffect(() => {
		if (activeProject && projectById.has(activeProject) && openMap[activeProject] === undefined) setOpen(activeProject, true);
	}, [activeProject, projectById, openMap, setOpen]);

	// ---- actions ----
	const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const run: TreeCtx["run"] = useCallback(
		async (fn, opts) => {
			opts?.optimistic?.();
			try {
				await fn();
				reload();
				return true;
			} catch (e) {
				opts?.revert?.();
				setNotice(errorText(e));
				clearTimeout(noticeTimer.current);
				noticeTimer.current = setTimeout(() => setNotice(undefined), 9000);
				reload();
				return false;
			}
		},
		[reload],
	);
	const patchConv = useCallback(
		(key: string, patch: Partial<ConversationSummary>) => convsRes.setData((d) => (d ? { ...d, conversations: d.conversations.map((c) => (convKey(c) === key ? { ...c, ...patch } : c)) } : d)),
		[convsRes],
	);
	const patchMeta = useCallback(
		(key: string, patch: Partial<ConvMeta>) =>
			metaRes.setData((d) => {
				const items = d?.items ?? [];
				const [spaceId, id] = [key.slice(0, key.lastIndexOf("/")), Number(key.slice(key.lastIndexOf("/") + 1))];
				const cur = items.find((i) => i.spaceId === spaceId && i.conversationId === id);
				const next: ConversationMetaDTO = { spaceId, conversationId: id, starred: cur?.starred ?? false, tags: cur?.tags ?? [], ...patch };
				return { items: cur ? items.map((i) => (i === cur ? next : i)) : [...items, next] };
			}),
		[metaRes],
	);
	const tree: TreeCtx = {
		meId: me?.userId,
		projects,
		projectById,
		moveTargets: groups.own,
		metaOf,
		onNavigate,
		run,
		patchConv,
		patchMeta,
		openProject: (id) => setOpen(id, true),
		reload,
	};

	const projectBlock = (p: UiProject) => {
		// Conversations shared through a container project are not part of my own list; they are listed under their project.
		if (isSharedToMe(p))
			return (
				<ProjectRow key={p.id} p={p} open={!!openMap[p.id]} onToggle={() => setOpen(p.id, !openMap[p.id])} tree={tree} count={p.conversationCount} instant={motionReduced}>
					<SharedConversations p={p} tree={tree} open={!!openMap[p.id]} />
				</ProjectRow>
			);
		const all = groups.byProject.get(p.id) ?? [];
		const shown = all.slice(0, PER_PROJECT);
		return (
			<ProjectRow key={p.id} p={p} open={!!openMap[p.id]} onToggle={() => setOpen(p.id, !openMap[p.id])} tree={tree} count={Math.max(p.conversationCount, all.length)} instant={motionReduced}>
				{shown.map((c) => (
					<ConversationRow key={convKey(c)} c={c} tree={tree} indent />
				))}
				{shown.length === 0 ? <p className="pl-8 pr-2 py-1 text-xs text-fg-muted">{p.conversationCount > 0 ? "对话较早，打开项目查看" : "还没有对话"}</p> : null}
				{all.length > shown.length || (p.conversationCount > shown.length && shown.length > 0) ? (
					<Link to={`/projects/${p.id}`} onClick={tree.onNavigate} className="block rounded-lg py-1 pl-8 pr-2 text-xs text-fg-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-ring">
						查看全部 {Math.max(p.conversationCount, all.length)} 个对话
					</Link>
				) : null}
			</ProjectRow>
		);
	};

	const loadingAll = (projectsRes.loading && !projectsRes.data) || (convsRes.loading && !convsRes.data);
	const projectCount = groups.own.length + groups.legacy.length + groups.shared.length;

	return (
		<>
			<div ref={scroller} data-testid="sidebar-scroll" className="wr-scroll mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
				{groups.starred.length > 0 ? (
					<Group title="星标" icon={<Star className="size-3 fill-current" />} open={sections.starred!} onToggle={() => toggleSection("starred")} testId="group-starred" instant={motionReduced}>
						{groups.starred.map((c) => (
							<ConversationRow key={convKey(c)} c={c} tree={tree} />
						))}
					</Group>
				) : null}

				<Group
					title="项目"
					open={sections.projects!}
					onToggle={() => toggleSection("projects")}
					testId="group-projects"
					instant={motionReduced}
					action={
						<Tip label="新建项目">
							<button aria-label="新建项目" data-testid="new-project" onClick={() => setNewProject(true)} className="inline-flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
								<Plus className="size-3.5" />
							</button>
						</Tip>
					}
				>
					{projectsRes.unavailable ? (
						<p className="px-2.5 py-1 text-xs text-fg-muted">项目暂时无法加载</p>
					) : projectsRes.error && !projectsRes.data ? (
						<p role="alert" className="px-2.5 py-1 text-xs text-danger">项目加载失败</p>
					) : projectCount === 0 && !projectsRes.loading ? (
						<p className="px-2.5 py-1 text-xs text-fg-muted">还没有项目</p>
					) : (
						<>
							{groups.own.map(projectBlock)}
							{groups.legacy.map(projectBlock)}
							{groups.shared.length > 0 ? (
								<>
									<p data-testid="group-shared-label" className="px-2.5 pb-0.5 pt-2 text-xs font-medium text-fg-muted">
										共享给我
									</p>
									{groups.shared.map(projectBlock)}
								</>
							) : null}
						</>
					)}
				</Group>

				<Group title="最近对话" open={sections.recent!} onToggle={() => toggleSection("recent")} testId="group-recent" instant={motionReduced}>
					{convsRes.unavailable ? (
						<p className="px-2.5 py-1 text-xs text-fg-muted">对话暂时无法加载</p>
					) : convsRes.error && !convsRes.data ? (
						<p className="px-2.5 py-1 text-xs text-danger">对话加载失败</p>
					) : groups.recent.length === 0 && !loadingAll ? (
						<p className="px-2.5 py-1 text-xs text-fg-muted">{convs.length === 0 ? "还没有对话" : "其余对话都在上面的星标和项目里"}</p>
					) : (
						groups.recent.map((c) => <ConversationRow key={convKey(c)} c={c} tree={tree} />)
					)}
				</Group>
			</div>
			{notice ? (
				<div role="alert" data-testid="sidebar-notice" className="mx-2 mb-2 flex items-start gap-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs text-danger">
					<span className="min-w-0 flex-1 break-words">{notice}</span>
					<button aria-label="关闭提示" onClick={() => setNotice(undefined)} className="shrink-0 rounded px-1 font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring">
						知道了
					</button>
				</div>
			) : null}
			<NewProjectDialog
				open={newProject}
				onOpenChange={setNewProject}
				onCreated={(p) => {
					setOpen(p.id, true);
					reloadProjects();
					navigate(`/projects/${p.id}`);
					onNavigate?.();
				}}
			/>
		</>
	);
}

function SharedConversations({ p, tree, open }: { p: UiProject; tree: TreeCtx; open: boolean }) {
	const res = useApi<{ conversations: ConversationSummary[] }>(open ? `/conversations?projectId=${encodeURIComponent(p.id)}&limit=50` : null, { pollMs: 15000 });
	const list = (res.data?.conversations ?? []).filter((c) => c.kind !== "subagent" && !c.archived);
	if (res.error && !res.data) return <p className="py-1 pl-8 pr-2 text-xs text-danger">对话加载失败</p>;
	if (list.length === 0) return <p className="py-1 pl-8 pr-2 text-xs text-fg-muted">{res.loading ? "加载中…" : "还没有可查看的对话"}</p>;
	return (
		<>
			{list.map((c) => (
				<ConversationRow key={convKey(c)} c={c} tree={tree} indent />
			))}
		</>
	);
}

function Group({ title, icon, open, onToggle, action, children, testId, instant }: { title: string; icon?: ReactNode; open: boolean; onToggle: () => void; action?: ReactNode; children: ReactNode; testId: string; instant?: boolean }) {
	return (
		<section data-testid={testId} aria-label={title} className="mb-2">
			<div className="flex items-center pr-1">
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={open}
					className="flex h-7 flex-1 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ChevronRight className={cn("size-3 transition-transform duration-200", open && "rotate-90")} />
					{icon}
					{title}
				</button>
				{action}
			</div>
			<Collapse open={open} instant={instant}>
				<div className="flex flex-col gap-px">{children}</div>
			</Collapse>
		</section>
	);
}
