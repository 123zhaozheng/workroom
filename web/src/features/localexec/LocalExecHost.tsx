// Round 11 (R4): runs code_run jobs for this tab. Renders nothing. A job announced on the conversation stream is claimed (first claim wins),
// its inputs are fetched, the code runs in the isolated runtime (runtime/frame.ts) and the result + output files are posted back.
// The stop button / a timeout on the server cancels the job (`localjob-cancel`); the runtime is then killed.
import { useEffect } from "react";
import type { LocalJobClaimResponse, LocalJobResultRequest } from "@shared/localexec";
import { ApiError, post } from "@/lib/api";
import { localExecBus, TAB_ID } from "./bus";
import { runtimeSupported, startRun, type RunHandle, type RunOutcome } from "./runtime/frame";

function toBase64(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

async function fetchInput(base: string, path: string): Promise<ArrayBuffer> {
	const res = await fetch(`/api${base}/input?tabId=${TAB_ID}&path=${encodeURIComponent(path)}`, { credentials: "same-origin" });
	if (!res.ok) throw new Error(`读取输入文件失败：${path}`);
	return res.arrayBuffer();
}

export function LocalExecHost({ spaceId, conversationId }: { spaceId: string; conversationId: number }) {
	useEffect(() => {
		if (!runtimeSupported()) return;
		const base = `/conversations/${spaceId}/${conversationId}/local-exec`;
		const running = new Map<string, RunHandle>();
		const handle = async (jobId: string) => {
			let job: LocalJobClaimResponse;
			try {
				job = await post<LocalJobClaimResponse>(`${base}/jobs/${jobId}/claim`, { tabId: TAB_ID });
			} catch (e) {
				if (e instanceof ApiError && (e.status === 409 || e.status === 404)) return; // another tab won, or the job is gone
				return;
			}
			const report = (r: Omit<LocalJobResultRequest, "tabId">) => post(`${base}/jobs/${jobId}/result`, { tabId: TAB_ID, ...r }).catch(() => {});
			let outcome: RunOutcome;
			try {
				const inputs = await Promise.all(job.inputs.map(async (i) => ({ path: i.path, data: await fetchInput(`${base}/jobs/${jobId}`, i.path) })));
				const h = startRun({ language: job.language, code: job.code, timeoutSec: job.timeoutSec, inputs, limits: job.limits });
				running.set(jobId, h);
				outcome = await h.promise;
			} catch (e) {
				return void (await report({ ok: false, error: { kind: "error", message: String((e as Error)?.message ?? e) } }));
			} finally {
				running.delete(jobId);
			}
			if (outcome.error?.message === "cancelled") return; // the server cancelled the job: nothing to report
			await report({
				ok: outcome.ok,
				stdout: outcome.stdout,
				stderr: outcome.stderr,
				returnValue: outcome.returnValue,
				durationMs: outcome.durationMs,
				...(outcome.error ? { error: outcome.error } : {}),
				files: outcome.files.map((f) => ({ path: f.path, base64: toBase64(f.data) })),
			});
		};
		return localExecBus.subscribe((e) => {
			if (e.kind === "job") void handle(e.job.jobId);
			else running.get(e.cancel.jobId)?.cancel();
		});
	}, [spaceId, conversationId]);
	return null;
}
