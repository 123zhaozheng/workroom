import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, get, post } from "./api";
import { hasAdminConsoleAccess } from "@shared/permissions";
import type { MeResponse } from "./types";

interface SessionCtx {
	status: "loading" | "anonymous" | "authenticated" | "offline";
	me?: MeResponse["me"];
	personalSpaceId?: string;
	brand: { name: string; tagline: string };
	refresh: () => Promise<void>;
	logout: () => Promise<void>;
	isOrgAdmin: boolean;
}
const Ctx = createContext<SessionCtx | null>(null);
const DEFAULT_BRAND = { name: "Workroom", tagline: "把要完成的事交给我" };

export function SessionProvider({ children }: { children: ReactNode }) {
	const [status, setStatus] = useState<SessionCtx["status"]>("loading");
	const [data, setData] = useState<MeResponse>();
	const [brand, setBrand] = useState(DEFAULT_BRAND);

	const refresh = useCallback(async () => {
		try {
			const r = await get<MeResponse>("/me");
			setData(r);
			if (r.brand) setBrand(r.brand);
			setStatus("authenticated");
		} catch (e) {
			setData(undefined);
			if (e instanceof ApiError && e.status === 401) {
				setStatus("anonymous");
				// brand is public via /health
				get<{ brand?: SessionCtx["brand"] }>("/health")
					.then((h) => h.brand && setBrand(h.brand))
					.catch(() => {});
			} else setStatus(e instanceof ApiError && e.status === 0 ? "offline" : "anonymous");
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		document.title = brand.name;
	}, [brand.name]);

	const logout = useCallback(async () => {
		await post("/auth/logout").catch(() => {});
		setData(undefined);
		setStatus("anonymous");
	}, []);

	// 组织管理 is shown to anybody holding an admin-console permission (auditors, billing admins, department admins ...), not just owner/admin.
	// Older servers without RBAC fields fall back to the legacy role.
	const me = data?.me;
	const isOrgAdmin = me?.permissionsAnywhere ? hasAdminConsoleAccess(me.permissionsAnywhere) : me?.orgRole === "owner" || me?.orgRole === "admin";
	return (
		<Ctx.Provider value={{ status, me: data?.me, personalSpaceId: data?.personalSpaceId, brand, refresh, logout, isOrgAdmin }}>
			{children}
		</Ctx.Provider>
	);
}

export function useSession(): SessionCtx {
	const c = useContext(Ctx);
	if (!c) throw new Error("SessionProvider missing");
	return c;
}
