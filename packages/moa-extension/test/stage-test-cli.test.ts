import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseStageTestArgs,
	planStageSequence,
	resolveStageTestTask,
	stageTestUsage,
	validateStagePrerequisites,
} from "../src/stage-test-cli";
import { writeStageArtifacts } from "../src/stage-artifacts";
import { emptyTco } from "../src/tco";
import { DEFAULT_OUTPUT_SCHEMA } from "../src/types";

describe("parseStageTestArgs", () => {
	it("parses full flag set", () => {
		const args = parseStageTestArgs(
			["--stage", "rewrite", "--task", "hi", "--from", "tmp/a", "--out", "tmp/b", "--rounds", "2", "--continue-on-fail"],
			"/cwd",
		);
		expect(args.stage).toBe("rewrite");
		expect(args.task).toBe("hi");
		expect(args.from).toBe(path.resolve("/cwd", "tmp/a"));
		expect(args.out).toBe(path.resolve("/cwd", "tmp/b"));
		expect(args.rounds).toBe(2);
		expect(args.continueOnFail).toBe(true);
		expect(args.help).toBe(false);
	});

	it("defaults stage=all and out under cwd/tmp/moa-stage", () => {
		const args = parseStageTestArgs(["--task", "x"], "/proj");
		expect(args.stage).toBe("all");
		expect(args.out).toBe(path.join("/proj", "tmp/moa-stage"));
	});

	it("sets help for --help / -h", () => {
		expect(parseStageTestArgs(["--help"], "/").help).toBe(true);
		expect(parseStageTestArgs(["-h"], "/").help).toBe(true);
	});

	it("rejects invalid stage", () => {
		expect(() => parseStageTestArgs(["--stage", "nope"], "/")).toThrow(/Invalid --stage/);
	});

	it("rejects unknown flag", () => {
		expect(() => parseStageTestArgs(["--wat"], "/")).toThrow(/Unknown argument/);
	});

	it("rejects missing value after flag", () => {
		expect(() => parseStageTestArgs(["--task"], "/")).toThrow(/Missing value/);
	});
});

describe("stageTestUsage", () => {
	it("mentions --stage and --from", () => {
		const text = stageTestUsage();
		expect(text).toContain("--stage");
		expect(text).toContain("--from");
	});
});

describe("resolveStageTestTask", () => {
	it("prefers --task over prior meta", () => {
		expect(
			resolveStageTestTask(
				{ stage: "discovery", out: "/o", continueOnFail: false, help: false, task: " from cli " },
				{ meta: { stage: "discovery", task: "from meta", ok: true, startedAt: "", durations: {} } },
			),
		).toBe("from cli");
	});

	it("falls back to prior plan.task", () => {
		expect(
			resolveStageTestTask(
				{ stage: "rewrite", out: "/o", continueOnFail: false, help: false },
				{ plan: { task: "prior", workers: [] } },
			),
		).toBe("prior");
	});

	it("returns empty when nothing available", () => {
		expect(resolveStageTestTask({ stage: "all", out: "/o", continueOnFail: false, help: false }, undefined)).toBe(
			"",
		);
	});
});

describe("planStageSequence", () => {
	it("all expands to five stages in order", () => {
		expect(planStageSequence("all")).toEqual(["discovery", "ask", "rewrite", "workers", "synthesis"]);
	});

	it("single stage returns itself", () => {
		expect(planStageSequence("rewrite")).toEqual(["rewrite"]);
	});
});

describe("validateStagePrerequisites", () => {
	it("discovery/all require a task string", () => {
		expect(validateStagePrerequisites({ stage: "discovery", task: "", hasTco: false, hasSurviving: false })).toEqual(
			{ ok: false, exitCode: 2, message: "Missing --task (required for discovery/all)" },
		);
		expect(validateStagePrerequisites({ stage: "all", task: "x", hasTco: false, hasSurviving: false }).ok).toBe(
			true,
		);
	});

	it("rewrite without tco and without --from fails", () => {
		const r = validateStagePrerequisites({
			stage: "rewrite",
			task: "t",
			hasTco: false,
			hasSurviving: false,
			hasFrom: false,
		});
		expect(r.ok).toBe(false);
		expect(r.exitCode).toBe(2);
		expect(r.message).toMatch(/rewrite needs --from/);
	});

	it("rewrite with --from but missing tco.json throws via requireArtifacts path", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moa-cli-"));
		const r = validateStagePrerequisites({
			stage: "rewrite",
			task: "t",
			hasTco: false,
			hasSurviving: false,
			hasFrom: true,
			fromDir: dir,
		});
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/tco\.json/);
	});

	it("rewrite with --from and tco.json passes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moa-cli-"));
		await writeStageArtifacts(dir, {
			meta: { stage: "discovery", task: "t", ok: true, startedAt: new Date().toISOString(), durations: {} },
			tco: emptyTco("t", "test"),
			outputSchema: DEFAULT_OUTPUT_SCHEMA,
		});
		const r = validateStagePrerequisites({
			stage: "rewrite",
			task: "t",
			hasTco: true,
			hasSurviving: false,
			hasFrom: true,
			fromDir: dir,
		});
		expect(r).toEqual({ ok: true });
	});

	it("synthesis without surviving and without --from fails", () => {
		const r = validateStagePrerequisites({
			stage: "synthesis",
			task: "t",
			hasTco: true,
			hasSurviving: false,
			hasFrom: false,
		});
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/workers\.json/);
	});
});
