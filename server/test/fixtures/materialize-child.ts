// Child process for the concurrent-materialisation test: writes one content-addressed directory and reports success.
import { writeContentAddressed } from "../../src/tools/market.ts";
const [dir, n] = process.argv.slice(2) as [string, string];
const enc = new TextEncoder();
const files = Array.from({ length: Number(n) }, (_, i) => ({ path: `references/f${i}.txt`, bytes: enc.encode(`content ${i}\n`.repeat(200)) }));
files.push({ path: "scripts/run.py", bytes: enc.encode("print('x')\n") }, { path: "SKILL.md", bytes: enc.encode("# x\n") });
writeContentAddressed(dir, files);
process.stdout.write("ok");
