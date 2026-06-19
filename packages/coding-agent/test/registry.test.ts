/**
 * Tests for the agentDir registry.
 *
 * Uses a temp HOME so the real `~/.omp/agent/registry.json` is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	findAgent,
	findStaleEntries,
	listRegistered,
	loadRegistry,
	pruneStaleEntries,
	registerAgent,
	saveRegistry,
	unregisterAgent,
} from "../src/skeleton/registry";

// Force a fresh HOME for the whole file. The registry module reads REGISTRY_PATH
// from process.env.HOME at call time, so pointing HOME at a temp dir keeps tests isolated.
const tempHome = path.join(os.tmpdir(), `pi-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const savedHome = process.env.HOME;

beforeEach(async () => {
	process.env.HOME = tempHome;
	await fs.rm(path.join(tempHome, ".omp"), { recursive: true, force: true });
});

afterEach(async () => {
	process.env.HOME = savedHome;
	await fs.rm(tempHome, { recursive: true, force: true });
});

describe("agentDir registry", () => {
	it("returns an empty registry when the file does not exist", async () => {
		const reg = await loadRegistry();
		expect(reg.version).toBe(1);
		expect(reg.agents).toEqual({});
	});

	it("registerAgent writes a new entry and findAgent returns it", async () => {
		const entry = await registerAgent("hr-bot", "/tmp/hr-bot");
		expect(entry.path).toBe(path.resolve("/tmp/hr-bot"));
		expect(entry.template).toBe("default");
		const found = await findAgent("hr-bot");
		expect(found).toBeDefined();
		expect(found?.path).toBe(path.resolve("/tmp/hr-bot"));
	});

	it("registerAgent overwrites an existing entry's path", async () => {
		await registerAgent("hr3", "/old/path");
		await registerAgent("hr3", "/new/path");
		const found = await findAgent("hr3");
		expect(found).toBeDefined();
		expect(found?.path).toBe(path.resolve("/new/path"));
	});

	it("unregisterAgent removes an entry and returns true", async () => {
		await registerAgent("hr3", "/tmp/hr3");
		expect(await unregisterAgent("hr3")).toBe(true);
		expect(await findAgent("hr3")).toBeUndefined();
	});

	it("unregisterAgent returns false for unknown names", async () => {
		expect(await unregisterAgent("nope")).toBe(false);
	});

	it("listRegistered returns all entries", async () => {
		await registerAgent("a", "/tmp/a");
		await registerAgent("b", "/tmp/b");
		const list = await listRegistered();
		const names = list.map(e => e.name).sort();
		expect(names).toEqual(["a", "b"]);
	});

	it("recovers from corrupt JSON by returning an empty registry", async () => {
		// Write garbage to the registry file
		const regFile = path.join(tempHome, ".omp", "agent", "registry.json");
		await fs.mkdir(path.dirname(regFile), { recursive: true });
		await Bun.write(regFile, "{ not valid json");
		const reg = await loadRegistry();
		expect(reg.agents).toEqual({});
		// Recovery: a fresh write should produce a valid file
		await saveRegistry(reg);
		await registerAgent("recovered", "/tmp/recovered");
		const found = await findAgent("recovered");
		expect(found).toBeDefined();
		expect(found?.path).toBe(path.resolve("/tmp/recovered"));
	});

	it("findStaleEntries reports entries whose path does not exist", async () => {
		await registerAgent("alive", await fs.mkdtemp(path.join(os.tmpdir(), "alive-")));
		await registerAgent("dead", "/nonexistent/never/was");
		const stale = await findStaleEntries();
		expect(stale).toEqual(["dead"]);
	});

	it("pruneStaleEntries removes dead entries and returns their names", async () => {
		const liveDir = await fs.mkdtemp(path.join(os.tmpdir(), "live-"));
		await registerAgent("alive", liveDir);
		await registerAgent("dead1", "/nonexistent/1");
		await registerAgent("dead2", "/nonexistent/2");
		const removed = await pruneStaleEntries();
		expect(removed.sort()).toEqual(["dead1", "dead2"]);
		expect(await findStaleEntries()).toEqual([]);
		const alive = await findAgent("alive");
		expect(alive).toBeDefined();
		expect(alive?.path).toBe(path.resolve(liveDir));
	});

	it("survives names that contain slashes (nested account ids)", async () => {
		await registerAgent("ops/hr", "/tmp/ops/hr");
		const found = await findAgent("ops/hr");
		expect(found?.path).toBe(path.resolve("/tmp/ops/hr"));
	});
});
