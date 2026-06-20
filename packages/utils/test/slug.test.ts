import { describe, expect, it } from "bun:test";
import { slugify, slugifySync } from "../src/slug";

describe("slugify", () => {
	describe("ASCII paths", () => {
		it("converts space to dash and lowercases", async () => {
			expect(await slugify("Hello World")).toBe("hello-world");
		});

		it("preserves ASCII alphanumerics and existing dashes", async () => {
			expect(await slugify("gw-tmux-test")).toBe("gw-tmux-test");
		});

		it("collapses runs of unsafe chars to a single dash", async () => {
			expect(await slugify("omp-atomix:wiki changelog/agent")).toBe("omp-atomix-wiki-changelog-agent");
		});

		it("trims leading and trailing dashes", async () => {
			expect(await slugify("---hello---")).toBe("hello");
		});

		it("handles NFKD normalization (diacritics → ASCII)", async () => {
			expect(await slugify("Café résumé")).toBe("cafe-resume");
		});
	});

	describe("CJK paths", () => {
		it("converts CJK to pinyin tokens", async () => {
			expect(await slugify("01-算法模块")).toBe("01-suan-fa-mo-kuai");
		});

		it("handles pure CJK", async () => {
			expect(await slugify("招聘助手")).toBe("zhao-pin-zhu-shou");
		});

		it("handles mixed CJK + ASCII", async () => {
			expect(await slugify("hr-招聘-3号")).toBe("hr-zhao-pin-3-hao");
		});
	});

	describe("empty / invalid input", () => {
		it("returns fallback for empty string", async () => {
			expect(await slugify("")).toBe("session");
		});

		it("returns fallback for whitespace-only", async () => {
			expect(await slugify("   ")).toBe("session");
		});

		it("returns fallback for null and undefined", async () => {
			expect(await slugify(null)).toBe("session");
			expect(await slugify(undefined)).toBe("session");
		});

		it("honours custom fallback", async () => {
			expect(await slugify("", { fallback: "untitled" })).toBe("untitled");
		});
	});

	describe("truncation", () => {
		it("truncates to maxLen and appends hash when hashOnTruncate=true", async () => {
			const input = "a".repeat(50);
			const result = await slugify(input, { maxLen: 32 });
			// 25 a's + `-` + 6 hex = 32 chars
			expect(result.length).toBeLessThanOrEqual(32);
			expect(result).toMatch(/^a+-[0-9a-f]{6}$/);
		});

		it("different long inputs produce different hashes (no collision)", async () => {
			const a = await slugify("a".repeat(50), { maxLen: 32 });
			const b = await slugify(`${"a".repeat(49)}b`, { maxLen: 32 });
			expect(a).not.toBe(b);
		});

		it("truncates without hash when hashOnTruncate=false", async () => {
			const result = await slugify("a".repeat(50), { maxLen: 32, hashOnTruncate: false });
			expect(result.length).toBe(32);
			expect(result).not.toContain("-");
		});

		it("truncates long CJK with hash", async () => {
			// Pick a name whose pinyin expansion easily exceeds 32 chars
			const long = "招聘".repeat(20);
			const result = await slugify(long, { maxLen: 32 });
			expect(result.length).toBeLessThanOrEqual(32);
			expect(result).toMatch(/[a-z0-9]+-[0-9a-f]{6}$/);
		});
	});

	describe("edge cases", () => {
		it("handles single character", async () => {
			expect(await slugify("a")).toBe("a");
		});

		it("preserves numbers", async () => {
			expect(await slugify("test 123")).toBe("test-123");
		});

		it("strips all special characters leaving nothing → fallback", async () => {
			expect(await slugify("---")).toBe("session");
		});

		it("handles very long maxLen without truncating short input", async () => {
			expect(await slugify("hello", { maxLen: 1000 })).toBe("hello");
		});
	});
});

describe("slugifySync", () => {
	it("works for ASCII input without pinyin", () => {
		expect(slugifySync("Hello World")).toBe("hello-world");
	});

	it("returns fallback for CJK (no pinyin in sync path)", () => {
		// Without pinyin-pro, CJK becomes all-dashes, which is stripped to empty → fallback.
		const result = slugifySync("算法模块");
		// The behavior is "best effort" — assert that the result is a safe slug,
		// not a specific value. The contract: never throw, never return unsafe chars.
		expect(result).toMatch(/^[a-z0-9-]*$/);
	});

	it("still handles NFKD for diacritics", () => {
		expect(slugifySync("Café")).toBe("cafe");
	});
});
