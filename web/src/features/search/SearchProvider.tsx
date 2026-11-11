// Global Ctrl/Cmd+K: one search modal for the whole signed-in shell, opened by the shortcut or by the sidebar's 搜索 entry.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { SearchModal } from "./SearchModal";

interface Ctx {
	open: () => void;
	close: () => void;
	isOpen: boolean;
}
const SearchCtx = createContext<Ctx>({ open: () => {}, close: () => {}, isOpen: false });
export const useSearchModal = () => useContext(SearchCtx);

export function SearchProvider({ children }: { children: ReactNode }) {
	const [isOpen, setOpen] = useState(false);
	const open = useCallback(() => setOpen(true), []);
	const close = useCallback(() => setOpen(false), []);

	useEffect(() => {
		const on = (e: KeyboardEvent) => {
			// Not while an IME is composing (Enter / letters belong to the composition).
			if (e.isComposing || e.keyCode === 229) return;
			if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setOpen((o) => !o);
			}
		};
		window.addEventListener("keydown", on);
		return () => window.removeEventListener("keydown", on);
	}, []);

	const value = useMemo(() => ({ open, close, isOpen }), [open, close, isOpen]);
	return (
		<SearchCtx.Provider value={value}>
			{children}
			<SearchModal open={isOpen} onOpenChange={setOpen} />
		</SearchCtx.Provider>
	);
}
