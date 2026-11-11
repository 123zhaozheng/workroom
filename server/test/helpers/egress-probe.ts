// Round 9: a tiny Python program run INSIDE a sandbox to report - not assert - what its network really gives. DNS, TCP :443, a TLS handshake
// (certificate deliberately not verified in that one step, only to tell "reachable but intercepted" from "unreachable"; no data is sent) and a
// normally VERIFIED HTTPS GET. The environment's own proxy/firewall may limit or intercept egress; this only reports what happened.
export const EGRESS_PROBE_PY = `import socket, ssl, urllib.request
try:
    ip = socket.gethostbyname('example.com'); print('dns', ip)
    s = socket.create_connection((ip, 443), timeout=10); print('tcp-connect ok')
    try:
        ssl._create_unverified_context().wrap_socket(s, server_hostname='example.com'); print('tls-handshake ok (certificate not verified in this step)')
    except Exception as e:
        print('tls-handshake-fail', type(e).__name__, str(e)[:80])
except Exception as e:
    print('dns-or-tcp-fail', type(e).__name__, str(e)[:100])
try:
    print('https', urllib.request.urlopen('https://example.com', timeout=10).status)
except Exception as e:
    print('https-fail', type(e).__name__, str(e)[:140])
`;
/** One line for the test output. */
export function probeLine(label: string, stdout: string, stderr = ""): string {
	return `[network probe] ${label}: ${/^https 200$/m.test(stdout) ? "HTTPS verified OK (HTTP 200)" : /tcp-connect ok/.test(stdout) ? "TCP reached, HTTPS NOT verified" : "NOT reached"} | ${stdout.trim().replace(/\n/g, " | ")}${stderr.trim() ? ` | stderr: ${stderr.trim().slice(0, 200)}` : ""}`;
}
