import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { ReadTool } from "@cornfield/coding-agent/tools/read";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

const RAW_JSON = '{"b":2,"a":1}';
const FEED_ITEMS = 12;
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${Array.from(
	{ length: FEED_ITEMS },
	(_, i) => `<item><title>item-${i + 1}</title><link>https://example.com/${i + 1}</link></item>`,
).join("")}</channel></rss>`;

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/data.json") {
				return new Response(RAW_JSON, { headers: { "content-type": "application/json" } });
			}
			if (pathname === "/feed.xml") {
				return new Response(FEED, { headers: { "content-type": "application/rss+xml" } });
			}
			return new Response("not found", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
});

function makeTool(): ReadTool {
	const session = {
		cwd: os.tmpdir(),
		hasUI: false,
		hasEditTool: false,
		getSessionFile: () => null,
		settings: Settings.isolated({
			"fetch.enabled": true,
			"fetch.blockPrivateUrls": false,
			"read.defaultLimit": 3000,
		}),
	} as unknown as ToolSession;
	return new ReadTool(session);
}

/**
 * `sel="raw"` promises the response body verbatim. Shaping it (JSON pretty-print,
 * feed-to-markdown with an item cap) makes the call unknowable to the caller: the
 * text looks plausible and nothing says the body was rewritten.
 */
describe("read <url> sel=raw", () => {
	it("returns a JSON body verbatim in raw mode", async () => {
		const text = getResultText(await makeTool().execute("c1", { path: `${baseUrl}/data.json`, sel: "raw" }));

		expect(text).toContain(RAW_JSON);
	});

	it("still pretty-prints JSON without raw", async () => {
		const text = getResultText(await makeTool().execute("c2", { path: `${baseUrl}/data.json` }));

		expect(text).not.toContain(RAW_JSON);
		expect(text).toContain('"b": 2');
	});

	it("returns every feed item in raw mode", async () => {
		const text = getResultText(await makeTool().execute("c3", { path: `${baseUrl}/feed.xml`, sel: "raw" }));

		expect((text.match(/item-\d+/g) ?? []).length).toBe(FEED_ITEMS);
	});

	it("caps a rendered feed without raw", async () => {
		const text = getResultText(await makeTool().execute("c4", { path: `${baseUrl}/feed.xml` }));

		expect((text.match(/item-\d+/g) ?? []).length).toBeLessThan(FEED_ITEMS);
	});
});
