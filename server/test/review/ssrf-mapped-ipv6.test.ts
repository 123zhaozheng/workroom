// Security review regression test (fails while the SSRF filter gap exists).
// server/src/tools/netpolicy.ts guards the `browse` tool and personal HTTP MCP connectors. Its isPrivateAddress()
// only recognises IPv4-mapped IPv6 in dotted form (::ffff:127.0.0.1). Node's URL parser normalises an IPv6 literal
// host to compressed HEX form (::ffff:7f00:1), which isPrivateAddress does not match — so loopback and the cloud
// metadata address pass the filter and pinnedRequest connects to them.
//   node --disable-warning=ExperimentalWarning --test server/test/review/ssrf-mapped-ipv6.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUrl } from "../../src/tools/netpolicy.ts";

test("review: browse/MCP URL filter must block IPv4-mapped IPv6 literals for loopback and metadata", async () => {
	for (const url of [
		"http://[::ffff:127.0.0.1]/", // 127.0.0.1 — host-local services
		"http://[::ffff:a9fe:a9fe]/latest/meta-data/", // 169.254.169.254 — cloud metadata / credentials
	]) {
		let blocked = false;
		try {
			await checkUrl(url);
		} catch {
			blocked = true;
		}
		assert.equal(blocked, true, `${url} was allowed by checkUrl (SSRF to internal address)`);
	}
});
