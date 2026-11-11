// Mounts the onboarding dialog for a signed-in user whose server-side flag says they have not finished it (GET /me → onboarded:false).
// "稍后" is remembered for this browser session only (sessionStorage, cleared when the person signs out), so the dialog is back at the
// next login. Finishing (完成 / 跳过引导) is stored on the server per user, so no other device or browser shows it again.
// Offline or unknown (`onboarded` absent, e.g. an older server): never shown, and nothing is guessed from localStorage.
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { post } from "@/lib/api";
import { useSession } from "@/lib/session";

const Onboarding = lazy(() => import("./Onboarding"));
const LATER = "wr.onboarding.later";

function readLater(userId: string | undefined): boolean {
	try {
		return !!userId && sessionStorage.getItem(`${LATER}:${userId}`) === "1";
	} catch {
		return false;
	}
}
function writeLater(userId: string | undefined, on: boolean): void {
	try {
		if (!userId) return;
		if (on) sessionStorage.setItem(`${LATER}:${userId}`, "1");
		else sessionStorage.removeItem(`${LATER}:${userId}`);
	} catch {
		/* storage unavailable: "later" lasts until the page is reloaded */
	}
}

/** Only inside the app: not on the sign-in pages or a public share link. */
const OUTSIDE_APP = /^\/(login|register|s\/)/;

/** Mounted once above the routes (so it also sees the sign-out that unmounts the app shell). */
export function OnboardingGuard() {
	const { status, me, refresh } = useSession();
	const { pathname } = useLocation();
	const userId = me?.userId;
	const onboarded = (me as { onboarded?: boolean } | undefined)?.onboarded;
	const [laterMem, setLaterMem] = useState(false);
	const later = laterMem || readLater(userId);

	// signing out forgets "later", so the next login starts the onboarding again
	useEffect(() => {
		if (status === "anonymous") {
			setLaterMem(false);
			try {
				for (const k of Object.keys(sessionStorage)) if (k.startsWith(LATER)) sessionStorage.removeItem(k);
			} catch {
				/* ignore */
			}
		}
	}, [status]);

	const onLater = useCallback(() => {
		writeLater(userId, true);
		setLaterMem(true);
	}, [userId]);
	const onComplete = useCallback(
		async (skipped: string[]) => {
			await post("/me/onboarding/complete", { skipped });
			writeLater(userId, false);
			await refresh();
		},
		[refresh, userId],
	);

	if (status !== "authenticated" || onboarded !== false || later || OUTSIDE_APP.test(pathname)) return null;
	return (
		<Suspense fallback={null}>
			<Onboarding onLater={onLater} onComplete={onComplete} />
		</Suspense>
	);
}
