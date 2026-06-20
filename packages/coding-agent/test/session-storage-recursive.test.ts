import { describe, expect, it } from "bun:test";
import { MemorySessionStorage } from "../src/session/session-storage";
import { sessionFilePath } from "../src/session/session-paths";

describe("listFilesSyncRecursive (MemorySessionStorage)", () => {
	it("finds files in by-date/<date>/ subdirs", () => {
		const storage = new MemorySessionStorage();
		const root = "/sessions";

		// Three sessions on different days
		const day1 = sessionFilePath(root, "019ee098-9baf-7000-96ff-2b209e5ea180", new Date("2026-06-19T10:00:00Z"));
		const day2 = sessionFilePath(root, "019ee099-aaaa-7000-96ff-2b209e5ea181", new Date("2026-06-20T10:00:00Z"));
		const day3 = sessionFilePath(root, "019ee09a-bbbb-7000-96ff-2b209e5ea182", new Date("2026-06-21T10:00:00Z"));

		storage.writeTextSync(day1, JSON.stringify({ type: "session", id: "a" }));
		storage.writeTextSync(day2, JSON.stringify({ type: "session", id: "b" }));
		storage.writeTextSync(day3, JSON.stringify({ type: "session", id: "c" }));

		const files = storage.listFilesSyncRecursive(root, "*.jsonl");
		expect(files).toHaveLength(3);
	});

	it("returns empty when root does not exist", () => {
		const storage = new MemorySessionStorage();
		expect(storage.listFilesSyncRecursive("/nonexistent", "*.jsonl")).toEqual([]);
	});

	it("ignores files outside by-date/ at the root", () => {
		const storage = new MemorySessionStorage();
		const root = "/sessions";
		storage.writeTextSync(`${root}/random.jsonl`, "{}");
		expect(storage.listFilesSyncRecursive(root, "*.jsonl")).toEqual([]);
	});
});
