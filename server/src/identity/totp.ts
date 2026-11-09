// RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) — verified offline against RFC test vectors in tests.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const b of buf) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(s: string): Buffer {
	const clean = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		const i = B32.indexOf(ch);
		if (i < 0) throw new Error("invalid base32");
		value = (value << 5) | i;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

export function newTotpSecret(): string {
	return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = 6, algo: "sha1" | "sha256" | "sha512" = "sha1"): string {
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(counter));
	const h = createHmac(algo, secret).update(msg).digest();
	const off = h[h.length - 1]! & 0xf;
	const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
	return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpAt(secretB32: string, timeMs: number, step = 30): string {
	return hotp(base32Decode(secretB32), Math.floor(timeMs / 1000 / step));
}

/** Returns the matched time step (for replay protection) or null. Accepts ±1 step of clock skew. */
export function verifyTotp(secretB32: string, code: string, timeMs: number, lastStep?: number | null): number | null {
	if (!/^\d{6}$/.test(code)) return null;
	const key = base32Decode(secretB32);
	const now = Math.floor(timeMs / 1000 / 30);
	for (const step of [now, now - 1, now + 1]) {
		if (lastStep != null && step <= lastStep) continue;
		const expect = Buffer.from(hotp(key, step));
		if (timingSafeEqual(expect, Buffer.from(code))) return step;
	}
	return null;
}

export function otpauthUrl(secret: string, account: string, issuer: string): string {
	return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
