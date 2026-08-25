import { describe, expect, it, vi } from "bun:test";
import * as prettier from "prettier";
import { formatContent } from "../src/formatter";

describe("formatContent", () => {
	it("pins .js files to the flow parser (no fallback to babel-ts)", async () => {
		const spy = vi.spyOn(prettier, "format").mockResolvedValue("formatted");
		try {
			const result = await formatContent("fixture.js", "const value = 1;\n");

			expect(spy).toHaveBeenCalledTimes(1);
			const [, options] = spy.mock.calls[0]!;
			expect(options.parser).toBe("flow");
			expect(result.didFormat).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});
});
