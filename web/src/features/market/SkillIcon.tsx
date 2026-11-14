// Skill card icon: rounded square, soft tinted background, linear lucide glyph with one stroke weight. Colours come from the theme tokens
// (color-mix over transparent), so every tone reads in light and dark. The glyph set is keyed by shared/skill-icons ids.
import { BarChart3, BookOpen, CalendarDays, CheckCheck, Code2, Database, FileSpreadsheet, FileText, FileType, GraduationCap, Globe, Image, Landmark, Languages, ListChecks, Lock, Mail, Megaphone, MessageSquare, Presentation, Scale, ScrollText, Search, ShieldAlert, ShieldCheck, Sparkles, Users, UsersRound, Video, Workflow, Wrench, AudioLines, PenLine, ChartPie, type LucideIcon } from "lucide-react";
import { SKILL_ICONS, iconDef, resolveSkillIcon, type IconTone, type SkillIconInput } from "@shared/skill-icons";
import { cn } from "@/lib/utils";

const GLYPH: Record<string, LucideIcon> = {
	"file-text": FileText,
	spreadsheet: FileSpreadsheet,
	presentation: Presentation,
	chart: BarChart3,
	"data-analysis": ChartPie,
	writing: PenLine,
	translate: Languages,
	code: Code2,
	search: Search,
	mail: Mail,
	calendar: CalendarDays,
	finance: Landmark,
	legal: Scale,
	compliance: ShieldCheck,
	risk: ShieldAlert,
	customer: UsersRound,
	image: Image,
	video: Video,
	audio: AudioLines,
	pdf: FileType,
	web: Globe,
	automation: Workflow,
	database: Database,
	knowledge: BookOpen,
	approval: CheckCheck,
	report: ScrollText,
	education: GraduationCap,
	marketing: Megaphone,
	people: Users,
	task: ListChecks,
	chat: MessageSquare,
	security: Lock,
	tool: Wrench,
	general: Sparkles,
};
/** Theme token behind each tone. */
const TONE_VAR: Record<IconTone, string> = {
	blue: "var(--info)",
	green: "var(--success)",
	amber: "var(--warning)",
	red: "var(--danger)",
	purple: "var(--kind-image)",
	teal: "var(--kind-code)",
	gold: "var(--kind-archive)",
};

export function SkillIcon({ skill, size = 36, className }: { skill: SkillIconInput; size?: number; className?: string }) {
	const r = resolveSkillIcon(skill);
	return <IconTile id={r.id} tone={r.tone} size={size} className={className} source={r.source} />;
}

export function IconTile({ id, tone, size = 36, className, source }: { id: string; tone: IconTone; size?: number; className?: string; source?: string }) {
	const G = GLYPH[id] ?? Sparkles;
	const c = TONE_VAR[tone];
	return (
		<span
			aria-hidden
			data-testid="skill-icon"
			data-icon={id}
			data-tone={tone}
			data-source={source}
			style={{ width: size, height: size, color: c, backgroundColor: `color-mix(in srgb, ${c} 13%, transparent)`, borderColor: `color-mix(in srgb, ${c} 22%, transparent)` }}
			className={cn("flex shrink-0 items-center justify-center rounded-[10px] border", className)}
		>
			<G style={{ width: Math.round(size * 0.5), height: Math.round(size * 0.5) }} strokeWidth={1.75} />
		</span>
	);
}

/** Icon chooser: automatic (clears the choice) + the whole library. */
export function IconPicker({ value, auto, onChange, disabled }: { value?: string; /** what automatic would show now */ auto: SkillIconInput; onChange: (id: string | null) => void; disabled?: boolean }) {
	const guess = resolveSkillIcon({ ...auto, icon: undefined });
	return (
		<div role="radiogroup" aria-label="图标" data-testid="icon-picker" className="flex flex-wrap gap-1.5">
			<button type="button" role="radio" aria-checked={!value} disabled={disabled} onClick={() => onChange(null)} data-testid="icon-auto" title="自动匹配" className={cn("flex h-9 items-center gap-1.5 rounded-[10px] border px-2 text-xs text-fg-muted hover:bg-surface-2", !value ? "border-accent bg-surface-2 text-fg" : "border-border")}>
				<IconTile id={guess.id} tone={guess.tone} size={24} />
				自动
			</button>
			{SKILL_ICONS.map((d) => (
				<button key={d.id} type="button" role="radio" aria-checked={value === d.id} aria-label={d.label} title={d.label} disabled={disabled} onClick={() => onChange(d.id)} data-testid={`icon-opt-${d.id}`} className={cn("rounded-[11px] border p-[3px] hover:bg-surface-2", value === d.id ? "border-accent bg-surface-2" : "border-transparent")}>
					<IconTile id={d.id} tone={iconDef(d.id)!.tone} size={30} />
				</button>
			))}
		</div>
	);
}
