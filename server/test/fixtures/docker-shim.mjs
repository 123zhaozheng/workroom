// A fake docker CLI for tests: records every invocation in $SHIM_DIR/calls.jsonl and behaves according to environment variables.
//   SHIM_DOWN=1            daemon unreachable            SHIM_OS=windows   Windows-container mode
//   SHIM_IMAGES=a,b        images present                SHIM_RUN=ok|hang|infra|exit:N|oom
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.SHIM_DIR;
const args = process.argv.slice(2);
const log = (o) => appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(o)}\n`);
const images = () => (existsSync(join(dir, "images")) ? readFileSync(join(dir, "images"), "utf8").split("\n").filter(Boolean) : (process.env.SHIM_IMAGES ?? "").split(",").filter(Boolean));
const cmd = args[0] === "image" || args[0] === "container" ? `${args[0]} ${args[1]}` : args[0];
log({ cmd, args });
const flag = (name) => {
	const i = args.indexOf(name);
	return i < 0 ? undefined : args[i + 1];
};
const down = () => {
	console.error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
	process.exit(1);
};
switch (cmd) {
	case "version":
		if (process.env.SHIM_DOWN) down();
		console.log(`24.0.7|${process.env.SHIM_OS ?? "linux"}|amd64`);
		break;
	case "info":
		console.log(`["name=seccomp,profile=builtin"]|${process.env.SHIM_INFO ?? "Docker Desktop"}`);
		break;
	case "image inspect": {
		const img = args[args.length - 1];
		if (images().includes(img)) console.log("sha256:fake");
		else (console.error(`Error: No such image: ${img}`), process.exit(1));
		break;
	}
	case "pull":
		writeFileSync(join(dir, "images"), `${[...images(), args[1]].join("\n")}\n`);
		console.log(`pulled ${args[1]}`);
		break;
	case "run": {
		const name = flag("--name");
		if (process.env.SHIM_RUN === "infra") (console.error("docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"), process.exit(125));
		const mode = process.env.SHIM_RUN ?? "ok";
		if (mode === "hang") {
			const marker = join(dir, `killed-${name}`);
			const t = setInterval(() => {
				if (existsSync(marker)) {
					clearInterval(t);
					process.exit(137);
				}
			}, 50);
			break;
		}
		if (mode === "oom") {
			writeFileSync(join(dir, `oom-${name}`), "1");
			process.exit(137);
		}
		console.log("shim-stdout");
		console.error("shim-stderr");
		process.exit(mode.startsWith("exit:") ? Number(mode.slice(5)) : 0);
		break;
	}
	case "kill":
		writeFileSync(join(dir, `killed-${args[1]}`), "1");
		break;
	case "container inspect": {
		// A container "exists" once its run was logged and it has not been removed (rm -f writes the killed- marker).
		const name = args[args.length - 1];
		const ran = existsSync(join(dir, "calls.jsonl")) && readFileSync(join(dir, "calls.jsonl"), "utf8").includes(`"--name","${name}"`);
		if (ran && !existsSync(join(dir, `killed-${name}`))) console.log("sha256:fakecontainer");
		else (console.error(`Error: No such container: ${name}`), process.exit(1));
		break;
	}
	case "inspect":
		console.log(existsSync(join(dir, `oom-${args[args.length - 1]}`)) ? "true" : "false");
		break;
	case "rm":
		for (const n of args) if (n.startsWith("wr-")) writeFileSync(join(dir, `killed-${n}`), "1");
		break;
	case "ps":
		if (existsSync(join(dir, "ps"))) process.stdout.write(readFileSync(join(dir, "ps"), "utf8"));
		break;
	default:
		console.error(`shim: unsupported ${cmd}`);
		process.exit(2);
}
