// Shared, session-scoped copy of the Harness 检视 switch/permission state, so every message bar does not fetch it again.
import { useEffect, useSyncExternalStore } from "react";
import type { HarnessInspectStatus } from "@shared/harness-inspect";
import { get } from "@/lib/api";
import { useSession } from "@/lib/session";

let value: HarnessInspectStatus | undefined;
let owner: string | undefined;
let inflight: Promise<void> | undefined;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function setHarnessInspectStatus(s: HarnessInspectStatus | undefined): void {
	value = s;
	emit();
}

export function refreshHarnessInspectStatus(): Promise<void> {
	inflight ??= get<HarnessInspectStatus>("/harness-inspect/status")
		.then(setHarnessInspectStatus)
		.catch(() => setHarnessInspectStatus(undefined))
		.finally(() => {
			inflight = undefined;
		});
	return inflight;
}

/** undefined while unknown (or when the server does not provide the feature): callers render nothing. */
export function useHarnessInspectStatus(): HarnessInspectStatus | undefined {
	const { me } = useSession();
	const key = me ? `${me.userId}:${me.orgId}` : undefined;
	const v = useSyncExternalStore(
		(f) => {
			subs.add(f);
			return () => subs.delete(f);
		},
		() => value,
		() => undefined,
	);
	useEffect(() => {
		if (!key) return;
		if (owner !== key) {
			owner = key;
			value = undefined;
			emit();
			void refreshHarnessInspectStatus();
		}
	}, [key]);
	return key && owner === key ? v : undefined;
}
