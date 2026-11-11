// Pure helper of the position rail: group `n` turns into at most `capacity` consecutive buckets (one tick each).
export interface Bucket {
	readonly from: number;
	/** Inclusive. */
	readonly to: number;
}

export function bucketize(n: number, capacity: number): Bucket[] {
	if (n <= 0) return [];
	if (n <= capacity) return Array.from({ length: n }, (_, i) => ({ from: i, to: i }));
	const cap = Math.max(1, capacity);
	const out: Bucket[] = [];
	for (let b = 0; b < cap; b++) {
		const from = Math.floor((b * n) / cap);
		const to = Math.floor(((b + 1) * n) / cap) - 1;
		out.push({ from, to: Math.max(from, to) });
	}
	return out;
}
