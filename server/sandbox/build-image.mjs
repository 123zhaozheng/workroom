#!/usr/bin/env node
// Build the Workroom sandbox image from server/sandbox/Dockerfile. Works on Windows, macOS and Linux (only needs the docker CLI).
//   node server/sandbox/build-image.mjs [tag]      default tag: workroom/sandbox:1
// Extra `docker build` arguments can be passed through BUILD_ARGS, e.g. (PowerShell)
//   $env:BUILD_ARGS="--build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple"; node server/sandbox/build-image.mjs
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tag = process.argv[2] ?? "workroom/sandbox:1";
const dir = dirname(fileURLToPath(import.meta.url));
const extra = (process.env.BUILD_ARGS ?? "").split(/\s+/).filter(Boolean);
const r = spawnSync("docker", ["build", ...extra, "-t", tag, dir], { stdio: "inherit", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
if (r.error) {
	console.error(`cannot run docker: ${r.error.message}. Install Docker Desktop (Windows/macOS) or Docker Engine (Linux) and make sure it is running.`);
	process.exit(1);
}
process.exit(r.status ?? 1);
