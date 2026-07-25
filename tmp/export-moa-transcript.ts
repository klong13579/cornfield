import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { reconstructMoaArchive } from "../packages/moa-extension/src/trace.ts";

const runId = process.argv[2] || "moa-20260719-102635-6tsulu";
const sessionRoot = path.join(os.homedir(), ".omp/agent/sessions");
const entries: unknown[] = [];

function walk(dir: string) {
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		const st = fs.statSync(p);
		if (st.isDirectory()) {
			walk(p);
			continue;
		}
		if (!name.endsWith(".jsonl")) continue;
		for (const line of fs.readFileSync(p, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				/* skip */
			}
		}
	}
}

walk(sessionRoot);
const result = reconstructMoaArchive(entries, runId);
if (!result) {
	console.error(`No moa archive found for runId "${runId}"`);
	process.exit(1);
}

const outDir = path.join(import.meta.dir);
const out = path.join(outDir, `${runId}-transcript.md`);
const header = [
	`# moa run ${result.manifest.runId}`,
	`- created: ${result.manifest.createdAt}`,
	`- task: ${result.manifest.task}`,
	`- workers: ${result.manifest.completedWorkers}/${result.manifest.workerCount}`,
	`- archive: ${result.manifest.chunks} chunk(s), ${result.manifest.bytes} bytes`,
	"",
	"## Timings",
	"```json",
	JSON.stringify(result.manifest.timings ?? {}, null, 2),
	"```",
	"",
].join("\n");

const body = header + result.content;
fs.writeFileSync(out, body);
console.log(out);
console.log(`bytes=${Buffer.byteLength(body)} workers=${result.manifest.completedWorkers}/${result.manifest.workerCount}`);
