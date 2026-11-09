// Per-viewer UI conveniences (theme, reduce-motion, sidebar collapsed). These live in localStorage
// only because they are device-local display preferences — never product state.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePref = "system" | "light" | "dark";
export interface Prefs {
	theme: ThemePref;
	/** In-app reduce-motion toggle; the system setting is always honoured as well. */
	reduceMotion: boolean;
	sidebarCollapsed: boolean;
	/** Animated dot-matrix background on the home and chat pages (user-requested; off = no canvas at all). */
	dotMatrix: boolean;
}
const DEFAULTS: Prefs = { theme: "system", reduceMotion: false, sidebarCollapsed: false, dotMatrix: true };
const KEY = "wr.prefs.v1";

function load(): Prefs {
	try {
		const raw = localStorage.getItem(KEY);
		return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULTS;
	} catch {
		return DEFAULTS;
	}
}

interface PrefsCtx extends Prefs {
	set: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
	/** Effective: system reduced-motion OR in-app toggle. */
	motionReduced: boolean;
}
const Ctx = createContext<PrefsCtx | null>(null);

function useMedia(q: string): boolean {
	const [m, setM] = useState(() => typeof matchMedia !== "undefined" && matchMedia(q).matches);
	useEffect(() => {
		const mq = matchMedia(q);
		const on = () => setM(mq.matches);
		on();
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, [q]);
	return m;
}
export { useMedia };

export function PrefsProvider({ children }: { children: ReactNode }) {
	const [prefs, setPrefs] = useState<Prefs>(load);
	const systemDark = useMedia("(prefers-color-scheme: dark)");
	const systemReduce = useMedia("(prefers-reduced-motion: reduce)");

	useEffect(() => {
		try {
			localStorage.setItem(KEY, JSON.stringify(prefs));
		} catch {
			/* storage unavailable: preferences stay in memory */
		}
	}, [prefs]);

	const dark = prefs.theme === "dark" || (prefs.theme === "system" && systemDark);
	useEffect(() => {
		document.documentElement.dataset.theme = dark ? "dark" : "light";
	}, [dark]);
	useEffect(() => {
		document.documentElement.dataset.reduceMotion = prefs.reduceMotion ? "true" : "false";
	}, [prefs.reduceMotion]);

	const value = useMemo<PrefsCtx>(
		() => ({ ...prefs, motionReduced: prefs.reduceMotion || systemReduce, set: (k, v) => setPrefs((p) => ({ ...p, [k]: v })) }),
		[prefs, systemReduce],
	);
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrefs(): PrefsCtx {
	const c = useContext(Ctx);
	if (!c) throw new Error("PrefsProvider missing");
	return c;
}
