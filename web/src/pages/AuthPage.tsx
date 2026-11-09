import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { post, errorText } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { BrandMark } from "@/components/shell/BrandMark";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
	const { status, brand, refresh } = useSession();
	const [sp] = useSearchParams();
	const navigate = useNavigate();
	const next = sp.get("next") || "/";
	const [form, setForm] = useState({ email: "", password: "", name: "", orgName: "", inviteCode: sp.get("invite") ?? "" });
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();

	if (status === "authenticated") return <Navigate to={next} replace />;

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setErr(undefined);
		try {
			if (mode === "login") await post("/auth/login", { email: form.email, password: form.password });
			else
				await post("/auth/register", {
					email: form.email,
					password: form.password,
					name: form.name || form.email.split("@")[0]!,
					...(form.orgName ? { orgName: form.orgName } : {}),
					...(form.inviteCode ? { inviteCode: form.inviteCode } : {}),
				});
			await refresh();
			navigate(next, { replace: true });
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: { target: { value: string } }) => setForm((s) => ({ ...s, [k]: e.target.value })) });

	return (
		<div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
			<div className="w-full max-w-[360px]">
				<div className="mb-8 flex flex-col items-center text-center">
					<BrandMark className="size-10 rounded-xl" />
					<h1 className="mt-4 text-xl font-semibold tracking-tight">{mode === "login" ? `登录 ${brand.name}` : `注册 ${brand.name}`}</h1>
					<p className="mt-1 text-[13px] text-fg-muted">{brand.tagline}</p>
				</div>
				<form onSubmit={submit} className="space-y-4" aria-label={mode === "login" ? "登录" : "注册"}>
					{mode === "register" ? (
						<div>
							<Label htmlFor="name">姓名</Label>
							<Input id="name" autoComplete="name" {...f("name")} placeholder="你的名字" />
						</div>
					) : null}
					<div>
						<Label htmlFor="email">邮箱</Label>
						<Input id="email" type="email" required autoComplete="email" {...f("email")} placeholder="name@company.com" />
					</div>
					<div>
						<Label htmlFor="password">密码</Label>
						<Input id="password" type="password" required minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} {...f("password")} placeholder="至少 8 位" />
					</div>
					{mode === "register" ? (
						<>
							<div>
								<Label htmlFor="org">组织名称（可选）</Label>
								<Input id="org" {...f("orgName")} placeholder="不填则创建个人工作区" />
							</div>
							<div>
								<Label htmlFor="invite">邀请码（可选，加入已有组织）</Label>
								<Input id="invite" {...f("inviteCode")} />
							</div>
						</>
					) : null}
					{err ? (
						<p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
							{err}
						</p>
					) : null}
					<Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>
						{busy ? <Spinner className="text-accent-fg" /> : null}
						{mode === "login" ? "登录" : "创建账号"}
					</Button>
				</form>
				<p className="mt-6 text-center text-[13px] text-fg-muted">
					{mode === "login" ? (
						<>
							还没有账号？<Link className="text-info hover:underline" to={`/register${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`}>注册</Link>
						</>
					) : (
						<>
							已有账号？<Link className="text-info hover:underline" to="/login">登录</Link>
						</>
					)}
				</p>
			</div>
		</div>
	);
}
