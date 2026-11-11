// Round 11 (R6): price per provider-hour (USD) for the estimated sandbox cost on the stats page. One number input per provider; empty = no price
// (then no cost is shown for that provider). Saved on blur / Enter. Permission: sandbox.policy.manage (the admin 沙箱 tab).
import { useEffect, useState } from "react";
import type { SandboxPricesDTO } from "@shared/sandbox-stats";
import { put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Input } from "@/components/ui/input";
import { useAct } from "./common";

const PROVIDERS: { id: string; name: string }[] = [
	{ id: "opensandbox", name: "OpenSandbox" },
	{ id: "e2b", name: "E2B" },
	{ id: "daytona", name: "Daytona" },
];

export function SandboxPrices() {
	const res = useApi<SandboxPricesDTO>("/sandbox/prices");
	const { busy, run, note } = useAct(() => res.reload());
	const prices = res.data?.prices;
	const [draft, setDraft] = useState<Record<string, string>>({});
	useEffect(() => {
		if (prices) setDraft(Object.fromEntries(PROVIDERS.map((p) => [p.id, prices[p.id] === undefined ? "" : String(prices[p.id])])));
	}, [prices]);
	if (!prices) return null;
	const commit = (id: string) => {
		const raw = (draft[id] ?? "").trim();
		const cur = prices[id];
		if (raw === "") {
			if (cur !== undefined) void run(() => put("/sandbox/prices", { prices: { [id]: null } }));
			return;
		}
		const n = Number(raw);
		if (!Number.isFinite(n) || n < 0) return setDraft((d) => ({ ...d, [id]: cur === undefined ? "" : String(cur) }));
		if (n !== cur) void run(() => put("/sandbox/prices", { prices: { [id]: n } }));
	};
	return (
		<section data-testid="sandbox-prices" className="mt-6 rounded-xl border border-border bg-surface px-4 py-3">
			<h3 className="mb-2 text-sm font-medium">沙箱单价</h3>
			<div className="grid gap-2 sm:grid-cols-3">
				{PROVIDERS.map((p) => (
					<label key={p.id} className="flex items-center justify-between gap-2 text-sm">
						<span className="text-fg-muted">{p.name} USD/小时</span>
						<Input
							data-testid={`price-${p.id}`}
							aria-label={`${p.name} 单价（USD/小时）`}
							type="number"
							min={0}
							step="any"
							inputMode="decimal"
							value={draft[p.id] ?? ""}
							disabled={busy}
							onChange={(e) => setDraft((d) => ({ ...d, [p.id]: e.target.value }))}
							onBlur={() => commit(p.id)}
							onKeyDown={(e) => e.key === "Enter" && commit(p.id)}
							className="h-8 w-24 text-sm"
						/>
					</label>
				))}
			</div>
			{note}
		</section>
	);
}
