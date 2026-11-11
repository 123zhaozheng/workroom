// First-login onboarding: a centred two-column dialog on a dimmed backdrop. Left = a calm CSS preview of the step (hidden on phones),
// right = the step. Only things that really exist: welcome, appearance (the client preferences), 两步验证 (the real TOTP enrol),
// done. There is no default-model step: the server has no per-user default model (only the organisation default; the composer
// remembers the last choice per browser), so it is left out instead of faking one.
//
// Escape / × = 稍后 (comes back at the next login), 跳过引导 = finished for good. Both are always visible.
import { ArrowLeft, ArrowRight, Check, Monitor, Moon, Sun, X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { usePrefs, type ThemePref } from "@/lib/prefs";
import { useSession } from "@/lib/session";
import { errorText } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TwoFactorSetup, useTotpEnabled } from "@/features/settings/TwoFactor";
import { Scene, type SceneId } from "./previews";
import "./onboarding.css";

const STEPS: readonly { id: SceneId; label: string }[] = [
	{ id: "welcome", label: "欢迎" },
	{ id: "appearance", label: "外观" },
	{ id: "security", label: "账号安全" },
	{ id: "done", label: "完成" },
];

export default function Onboarding({ onLater, onComplete }: { onLater: () => void; onComplete: (skipped: string[]) => Promise<void> }) {
	const [i, setI] = useState(0);
	const [dir, setDir] = useState<"next" | "back">("next");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const prefs = usePrefs();
	const totpOn = useTotpEnabled();
	const heading = useRef<HTMLHeadingElement>(null);
	const step = STEPS[i]!;
	const last = i === STEPS.length - 1;

	// Each step moves focus to its heading: screen readers announce it, and Tab continues from there.
	useEffect(() => {
		heading.current?.focus({ preventScroll: true });
	}, [i]);

	const go = (to: number) => {
		setDir(to > i ? "next" : "back");
		setErr(undefined);
		setI(to);
	};
	const finish = async (skippedEarly: boolean) => {
		setBusy(true);
		setErr(undefined);
		// what was passed over without being done: 外观 only when the person leaves before it, 两步验证 unless it is on
		const skipped = [...(skippedEarly && i < 1 ? ["appearance"] : []), ...(!totpOn ? ["security"] : [])];
		try {
			await onComplete(skipped);
		} catch (e) {
			setErr(`没能保存：${errorText(e)}`);
			setBusy(false);
		}
	};

	const nextLabel = last ? "开始使用" : step.id === "security" && !totpOn ? "暂时跳过" : "下一步";
	return (
		<D.Root open onOpenChange={(o) => !o && !busy && onLater()}>
			<D.Portal>
				<D.Overlay className="fixed inset-0 z-[80] bg-[var(--overlay)] backdrop-blur-[2px] wr-fade-in" />
				<D.Content
					data-testid="onboarding-dialog"
					onInteractOutside={(e) => e.preventDefault()}
					onOpenAutoFocus={(e) => {
						e.preventDefault();
						heading.current?.focus({ preventScroll: true });
					}}
					className="ob-dialog-in fixed left-1/2 top-1/2 z-[80] flex h-[min(560px,calc(100dvh-24px))] w-[calc(100vw-24px)] max-w-[820px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-pop focus:outline-none"
				>
					<D.Title className="sr-only">新用户引导</D.Title>
					<D.Description className="sr-only">用几步完成基本设置，每一步都可以跳过。</D.Description>
					<div className="hidden w-[300px] shrink-0 border-r border-border md:block">
						<Scene id={step.id} dots={prefs.dotMatrix} />
					</div>
					<div className="flex min-w-0 flex-1 flex-col">
						<div className="flex h-14 shrink-0 items-center justify-between gap-3 px-5">
							<ol aria-label="引导进度" data-testid="onboarding-dots" className="flex items-center gap-2">
								{STEPS.map((s, n) => (
									<li key={s.id} data-testid="onboarding-dot" data-state={n === i ? "current" : n < i ? "done" : "todo"} aria-current={n === i ? "step" : undefined} className="flex items-center">
										<span className="sr-only">
											第 {n + 1} 步：{s.label}
											{n < i ? "，已完成" : ""}
										</span>
										<span aria-hidden className={cn("block h-2 rounded-full transition-all", n === i ? "w-6 bg-accent" : n < i ? "w-2 bg-fg-subtle" : "w-2 bg-surface-3")} />
									</li>
								))}
							</ol>
							<button
								type="button"
								data-testid="onboarding-later"
								onClick={onLater}
								disabled={busy}
								aria-label="稍后再看，下次登录时继续"
								title="稍后再看（Esc）"
								className="-mr-2 inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
							>
								稍后
								<X className="size-4" aria-hidden />
							</button>
						</div>
						<div role="status" aria-live="polite" className="sr-only">
							第 {i + 1} 步，共 {STEPS.length} 步：{step.label}
						</div>
						<div key={step.id} data-testid="onboarding-step" data-step={step.id} data-dir={dir} className="ob-step-in wr-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-1 md:px-8">
							{step.id === "welcome" ? <WelcomeStep headingRef={heading} /> : null}
							{step.id === "appearance" ? <AppearanceStep headingRef={heading} /> : null}
							{step.id === "security" ? <SecurityStep headingRef={heading} enabled={totpOn} /> : null}
							{step.id === "done" ? <DoneStep headingRef={heading} /> : null}
						</div>
						{err ? (
							<p role="alert" data-testid="onboarding-error" className="mx-5 mb-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger md:mx-8">
								{err}
							</p>
						) : null}
						<div className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3 md:px-8">
							{!last ? (
								<Button variant="ghost" data-testid="onboarding-skip" onClick={() => void finish(true)} disabled={busy} className="-ml-2.5 text-fg-muted">
									跳过引导
								</Button>
							) : null}
							<span className="flex-1" />
							{i > 0 && !last ? (
								<Button data-testid="onboarding-back" onClick={() => go(i - 1)} disabled={busy}>
									<ArrowLeft />
									上一步
								</Button>
							) : null}
							<Button
								variant={step.id === "security" && !totpOn ? "secondary" : "primary"}
								data-testid="onboarding-next"
								onClick={() => (last ? void finish(false) : go(i + 1))}
								disabled={busy}
							>
								{nextLabel}
								{!last ? <ArrowRight /> : null}
							</Button>
						</div>
					</div>
				</D.Content>
			</D.Portal>
		</D.Root>
	);
}

type HeadRef = React.Ref<HTMLHeadingElement>;
function Head({ headingRef, children }: { headingRef: HeadRef; children: ReactNode }) {
	return (
		<h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
			{children}
		</h2>
	);
}

function WelcomeStep({ headingRef }: { headingRef: HeadRef }) {
	const { brand, me } = useSession();
	return (
		<div className="space-y-3">
			<Head headingRef={headingRef}>欢迎使用 {brand.name}</Head>
			<p className="text-[15px] leading-relaxed text-fg">
				{me?.name ? `${me.name}，` : ""}
				{brand.name} 是你的在线工作助手。
			</p>
		</div>
	);
}

const THEMES: { value: ThemePref; label: string; icon: typeof Sun; swatch: string }[] = [
	{ value: "system", label: "跟随系统", icon: Monitor, swatch: "ob-swatch-system" },
	{ value: "light", label: "浅色", icon: Sun, swatch: "ob-swatch-light" },
	{ value: "dark", label: "深色", icon: Moon, swatch: "ob-swatch-dark" },
];

/** Three theme cards as one radio group (arrow keys move and select; only the chosen one is a Tab stop). */
function ThemeChoice() {
	const prefs = usePrefs();
	const refs = useRef<(HTMLButtonElement | null)[]>([]);
	const onKey = (e: KeyboardEvent, n: number) => {
		const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
		if (!d) return;
		e.preventDefault();
		const to = (n + d + THEMES.length) % THEMES.length;
		prefs.set("theme", THEMES[to]!.value);
		refs.current[to]?.focus();
	};
	return (
		<div role="radiogroup" aria-label="主题" data-testid="onboarding-theme" className="grid grid-cols-3 gap-2">
			{THEMES.map((t, n) => {
				const on = prefs.theme === t.value;
				const Icon = t.icon;
				return (
					<button
						key={t.value}
						ref={(el) => {
							refs.current[n] = el;
						}}
						type="button"
						role="radio"
						aria-checked={on}
						tabIndex={on ? 0 : -1}
						data-testid={`onboarding-theme-${t.value}`}
						onClick={() => prefs.set("theme", t.value)}
						onKeyDown={(e) => onKey(e, n)}
						className={cn("flex flex-col gap-2 rounded-xl border p-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", on ? "border-fg bg-surface-2" : "border-border hover:border-border-strong")}
					>
						<span aria-hidden className={cn("ob-swatch", t.swatch)} />
						<span className="flex items-center gap-1.5 px-0.5">
							<Icon className="size-4 text-fg-muted" aria-hidden />
							<span className="flex-1">{t.label}</span>
							{on ? <Check className="size-4" aria-hidden /> : null}
						</span>
					</button>
				);
			})}
		</div>
	);
}

function AppearanceStep({ headingRef }: { headingRef: HeadRef }) {
	const prefs = usePrefs();
	return (
		<div className="space-y-4">
			<Head headingRef={headingRef}>选一个顺眼的外观</Head>
			<ThemeChoice />
			<div className="divide-y divide-border border-y border-border text-sm">
				<div className="flex items-center gap-3 py-3">
					<label htmlFor="ob-reduce" className="min-w-0 flex-1">
						减少动画
					</label>
					<Switch id="ob-reduce" data-testid="onboarding-reduce-motion" checked={prefs.reduceMotion} onCheckedChange={(v) => prefs.set("reduceMotion", v)} />
				</div>
				<div className="flex items-center gap-3 py-3">
					<label htmlFor="ob-dots" className="min-w-0 flex-1">
						动态点阵背景
					</label>
					<Switch id="ob-dots" data-testid="onboarding-dot-matrix" checked={prefs.dotMatrix} onCheckedChange={(v) => prefs.set("dotMatrix", v)} />
				</div>
			</div>
		</div>
	);
}

function SecurityStep({ headingRef, enabled }: { headingRef: HeadRef; enabled: boolean }) {
	return (
		<div className="space-y-4">
			<Head headingRef={headingRef}>账号安全</Head>
			{enabled ? (
				<div data-testid="onboarding-totp-on" role="status" className="flex items-start gap-2 rounded-lg bg-success-soft px-3 py-2.5 text-sm text-success">
					<Check className="mt-0.5 size-4 shrink-0" aria-hidden />
					<span>两步验证已启用</span>
				</div>
			) : (
				<>
					<TwoFactorSetup />
				</>
			)}
		</div>
	);
}

function DoneStep({ headingRef }: { headingRef: HeadRef }) {
	return (
		<div className="space-y-3">
			<Head headingRef={headingRef}>准备好了</Head>
			<p className="text-[15px]">在首页描述要做的事，开始第一次对话。</p>
		</div>
	);
}
