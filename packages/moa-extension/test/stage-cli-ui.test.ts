import { describe, expect, it } from "bun:test";
import { createStageCliUI, type StageCliIo } from "../src/stage-cli-ui";

function makeIo(lines: string[]): StageCliIo & { writes: string[] } {
	const queue = [...lines];
	const writes: string[] = [];
	return {
		writes,
		write(text: string) {
			writes.push(text);
		},
		async readLine() {
			return queue.shift() ?? "";
		},
	};
}

describe("createStageCliUI", () => {
	it("input returns typed line", async () => {
		const io = makeIo(["hello world"]);
		const ui = createStageCliUI(io);
		const ans = await ui.input("Q?");
		expect(ans).toBe("hello world");
		expect(io.writes.join("")).toContain("Q?");
	});

	it("input returns undefined on empty line (skip)", async () => {
		const io = makeIo([""]);
		const ui = createStageCliUI(io);
		expect(await ui.input("Q?")).toBeUndefined();
	});

	it("select returns chosen option by 1-based index", async () => {
		const io = makeIo(["2"]);
		const ui = createStageCliUI(io);
		const ans = await ui.select("Pick", ["alpha", "beta", "gamma"]);
		expect(ans).toBe("beta");
		expect(io.writes.join("")).toContain("1) alpha");
		expect(io.writes.join("")).toContain("2) beta");
	});

	it("select returns undefined on empty / invalid", async () => {
		const io = makeIo([""]);
		const ui = createStageCliUI(io);
		expect(await ui.select("Pick", ["a", "b"])).toBeUndefined();
	});

	it("notify writes to stderr-style stream", async () => {
		const io = makeIo([]);
		const ui = createStageCliUI(io);
		ui.notify("hello", "warning");
		expect(io.writes.join("")).toContain("[warning] hello");
	});
});
