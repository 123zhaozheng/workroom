// 两步验证 (TOTP). One enrol flow shared by 设置 → 安全 and the first-login onboarding, and the settings group with disable.
// Real routes only: POST /me/2fa/setup → { secret, otpauthUrl }, POST /me/2fa/enable { code }, POST /me/2fa/disable { code }.
// The server has no recovery codes and no QR endpoint, so the flow shows the secret (grouped, copyable) and the authenticator link
// instead of inventing either. Enabling signs every other device out (the server revokes their sessions); the UI says so first.
import { Check, Copy, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { errorText, post } from "@/lib/api";
import { copyText } from "@/lib/utils";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Spinner } from "@/components/ui/misc";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { SettingsGroup, SettingsRow } from "@/components/ui/settings";

interface SetupResponse {
	secret: string;
	otpauthUrl: string;
}

/** "ABCDEFGH" → "ABCD EFGH": easier to read aloud and to type, the authenticator ignores the spaces. */
export const groupSecret = (s: string) => s.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();

/** Whether this account has 2FA on (from /me). */
export function useTotpEnabled(): boolean {
	const { me } = useSession();
	return !!(me as { totpEnabled?: boolean } | undefined)?.totpEnabled;
}

function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
	const [done, setDone] = useState(false);
	useEffect(() => {
		if (!done) return;
		const t = setTimeout(() => setDone(false), 1600);
		return () => clearTimeout(t);
	}, [done]);
	return (
		<Button size="sm" data-testid={testId} onClick={async () => setDone(await copyText(text))}>
			{done ? <Check /> : <Copy />}
			{done ? "已复制" : label}
		</Button>
	);
}

/**
 * Enrol: generate a secret, show it, check one code, enable. `onEnabled` fires after the server accepted the code.
 * `autoStart` skips the intro button (used when the person already chose to enable).
 */
export function TwoFactorSetup({ onEnabled, onCancel, autoStart, headingRef }: { onEnabled?: () => void; onCancel?: () => void; autoStart?: boolean; headingRef?: React.Ref<HTMLHeadingElement> }) {
	const [setup, setSetup] = useState<SetupResponse>();
	const [starting, setStarting] = useState(false);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const codeId = useId();
	const codeRef = useRef<HTMLInputElement>(null);
	const { refresh } = useSession();

	const start = async () => {
		setStarting(true);
		setErr(undefined);
		try {
			setSetup(await post<SetupResponse>("/me/2fa/setup"));
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setStarting(false);
		}
	};
	const started = useRef(false);
	useEffect(() => {
		if (autoStart && !started.current) {
			started.current = true;
			void start();
		}
	}, [autoStart]);
	useEffect(() => {
		if (setup) codeRef.current?.focus();
	}, [setup]);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!/^\d{6}$/.test(code) || busy) return;
		setBusy(true);
		setErr(undefined);
		try {
			await post("/me/2fa/enable", { code });
			await refresh();
			onEnabled?.();
		} catch (e2) {
			setErr(errorText(e2));
			setCode("");
			codeRef.current?.focus();
		} finally {
			setBusy(false);
		}
	};

	if (!setup)
		return (
			<div data-testid="totp-intro" className="space-y-3">
				<h3 ref={headingRef} tabIndex={-1} className="text-sm font-medium outline-none">
					用验证器 App 保护账号
				</h3>
				<p className="text-sm text-fg-muted">启用后，其他设备上的登录会失效。</p>
				{err ? (
					<p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
						{err}
					</p>
				) : null}
				<div className="flex flex-wrap gap-2">
					<Button variant="primary" onClick={start} disabled={starting} data-testid="totp-start">
						{starting ? <Spinner className="text-accent-fg" /> : <ShieldCheck />}
						开始设置
					</Button>
					{onCancel ? (
						<Button variant="ghost" onClick={onCancel}>
							暂不启用
						</Button>
					) : null}
				</div>
			</div>
		);

	return (
		<form data-testid="totp-setup" onSubmit={submit} className="space-y-4">
			<div>
				<h3 ref={headingRef} tabIndex={-1} className="text-sm font-medium outline-none">
					1. 在验证器 App 里添加账号
				</h3>
				<div className="mt-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
					<div className="text-xs text-fg-muted">密钥</div>
					<code data-testid="totp-secret" data-secret={setup.secret} className="mt-0.5 block break-all font-mono text-[15px] font-medium tracking-wider text-fg" aria-label={`密钥 ${setup.secret.split("").join(" ")}`}>
						{groupSecret(setup.secret)}
					</code>
				</div>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<CopyButton text={setup.secret} label="复制密钥" testId="totp-copy-secret" />
					<CopyButton text={setup.otpauthUrl} label="复制配置链接" testId="totp-copy-uri" />
					<a href={setup.otpauthUrl} data-testid="totp-open-app" className="inline-flex h-8 items-center rounded-lg px-2.5 text-sm text-info hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						在验证器中打开
					</a>
				</div>
				<p className="mt-2 text-xs text-fg-muted">本系统不提供恢复码，请把密钥保存在安全的地方。</p>
			</div>
			<div>
				<h3 className="text-sm font-medium">2. 输入验证器显示的 6 位数字</h3>
				<label htmlFor={codeId} className="sr-only">
					验证码
				</label>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<Input
						id={codeId}
						ref={codeRef}
						data-testid="totp-code"
						value={code}
						onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
						inputMode="numeric"
						autoComplete="one-time-code"
						maxLength={6}
						placeholder="6 位数字"
						aria-invalid={err ? true : undefined}
						className="w-36 text-center font-mono text-base tracking-[0.3em] placeholder:font-sans placeholder:text-sm placeholder:tracking-normal"
					/>
					<Button type="submit" variant="primary" disabled={busy || code.length !== 6} data-testid="totp-enable">
						{busy ? <Spinner className="text-accent-fg" /> : null}
						验证并启用
					</Button>
					{onCancel ? (
						<Button variant="ghost" onClick={onCancel} disabled={busy}>
							取消
						</Button>
					) : null}
				</div>
				{err ? (
					<p role="alert" data-testid="totp-error" className="mt-2 text-sm text-danger">
						{err}
					</p>
				) : null}
			</div>
		</form>
	);
}

/** 设置 → 安全 → 两步验证: state, enable (inline flow) and disable (asks for a current code). */
export function TwoFactorSettings() {
	const enabled = useTotpEnabled();
	const { refresh } = useSession();
	const [setting, setSetting] = useState(false);
	const [disabling, setDisabling] = useState(false);
	return (
		<>
			<SettingsGroup title="两步验证" testId="two-factor">
				<SettingsRow label="验证器 App" stack>
					<span data-testid="totp-status" data-enabled={enabled ? "true" : "false"}>
						{enabled ? <Badge tone="success">已启用</Badge> : <Badge>未启用</Badge>}
					</span>
					{enabled ? (
						<Button size="sm" onClick={() => setDisabling(true)} data-testid="totp-disable-open">
							关闭
						</Button>
					) : !setting ? (
						<Button size="sm" variant="primary" onClick={() => setSetting(true)} data-testid="totp-enable-open">
							启用
						</Button>
					) : null}
				</SettingsRow>
			</SettingsGroup>
			{setting && !enabled ? (
				<div className="-mt-4 mb-8 rounded-xl border border-border bg-surface p-4">
					<TwoFactorSetup
						autoStart
						onCancel={() => setSetting(false)}
						onEnabled={() => {
							setSetting(false);
						}}
					/>
				</div>
			) : null}
			<DisableDialog
				open={disabling}
				onOpenChange={setDisabling}
				onDisabled={async () => {
					setDisabling(false);
					await refresh();
				}}
			/>
		</>
	);
}

function DisableDialog({ open, onOpenChange, onDisabled }: { open: boolean; onOpenChange: (o: boolean) => void; onDisabled: () => void | Promise<void> }) {
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	useEffect(() => {
		if (open) {
			setCode("");
			setErr(undefined);
		}
	}, [open]);
	const id = useId();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="关闭两步验证">
				<form
					className="space-y-3"
					onSubmit={async (e) => {
						e.preventDefault();
						if (code.length !== 6 || busy) return;
						setBusy(true);
						setErr(undefined);
						try {
							await post("/me/2fa/disable", { code });
							await onDisabled();
						} catch (e2) {
							setErr(errorText(e2));
							setCode("");
						} finally {
							setBusy(false);
						}
					}}
				>
					<label htmlFor={id} className="sr-only">
						验证码
					</label>
					<Input id={id} data-testid="totp-disable-code" autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6 位数字" className="w-40 text-center font-mono text-base tracking-[0.3em] placeholder:font-sans placeholder:text-sm placeholder:tracking-normal" />
					{err ? (
						<p role="alert" data-testid="totp-disable-error" className="text-sm text-danger">
							{err}
						</p>
					) : null}
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="submit" variant="danger" disabled={busy || code.length !== 6} data-testid="totp-disable-confirm">
							关闭两步验证
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
