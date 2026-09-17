import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@cornfield/coding-agent/config/settings";
import type { ToolSession } from "@cornfield/coding-agent/tools";
import { GithubTool } from "@cornfield/coding-agent/tools/gh";
import { ToolError } from "@cornfield/coding-agent/tools/tool-errors";
import * as git from "@cornfield/coding-agent/utils/git";

function createSession(settings: Settings = Settings.isolated({ "github.enabled": true })): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

function textParts(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

/** PNG signature + IHDR, enough for the image sniffer to report 3x2 RGBA. */
const PNG_BYTES = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from([0x00, 0x00, 0x00, 0x0d]),
	Buffer.from("IHDR", "ascii"),
	Buffer.from([0x00, 0x00, 0x00, 0x03]),
	Buffer.from([0x00, 0x00, 0x00, 0x02]),
	Buffer.from([0x08, 0x06]),
]);

function contentsResponse(overrides: Record<string, unknown>): Record<string, unknown> {
	return { type: "file", encoding: "base64", size: 12, html_url: null, ...overrides };
}

describe("github file_read op", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads a text file through the contents API and links its source", async () => {
		const jsonSpy = vi.spyOn(git.github, "json").mockResolvedValue(
			contentsResponse({
				content: Buffer.from("line one\nline two\n").toBase64(),
				html_url: "https://github.com/owner/repo/blob/dev/README.md",
			}) as never,
		);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("file-read", {
			op: "file_read",
			repo: "owner/repo",
			path: "README.md",
			branch: "dev",
		});

		expect(jsonSpy.mock.calls[0]?.[1]).toEqual([
			"api",
			"--method",
			"GET",
			"/repos/owner/repo/contents/README.md",
			"-H",
			"Accept: application/vnd.github+json",
			"-H",
			"Accept-Encoding: identity",
			"-f",
			"ref=dev",
		]);
		expect(textParts(result)).toBe("line one\nline two\n");
		expect(result.details?.repo).toBe("owner/repo");
		expect(result.details?.branch).toBe("dev");
		expect(result.details?.meta?.source?.value).toBe("https://github.com/owner/repo/blob/dev/README.md");
	});

	it("decodes base64 that GitHub wrapped across lines and falls back to a blob URL", async () => {
		const wrapped = Buffer.from("wrapped body")
			.toBase64()
			.replace(/(.{4})/g, "$1\n");
		vi.spyOn(git.github, "json").mockResolvedValue(contentsResponse({ content: wrapped }) as never);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("file-read", { op: "file_read", repo: "owner/repo", path: "README.md" });

		expect(textParts(result)).toBe("wrapped body");
		// No html_url came back, so the fallback has to name repo, revision and path.
		expect(result.details?.meta?.source?.value).toBe("https://github.com/owner/repo/blob/HEAD/README.md");
	});

	it("percent-encodes each path segment without touching the separators", async () => {
		const jsonSpy = vi
			.spyOn(git.github, "json")
			.mockResolvedValue(contentsResponse({ content: Buffer.from("x").toBase64() }) as never);

		const tool = new GithubTool(createSession());
		await tool.execute("file-read", { op: "file_read", repo: "owner/repo", path: "docs/my file#1.md" });

		expect(jsonSpy.mock.calls[0]?.[1]?.[3]).toBe("/repos/owner/repo/contents/docs/my%20file%231.md");
	});

	it("returns an image as an attachment the model can see", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue(
			contentsResponse({
				content: PNG_BYTES.toBase64(),
				size: PNG_BYTES.byteLength,
				html_url: "https://github.com/owner/repo/blob/main/docs/logo.png",
			}) as never,
		);

		// autoResize is off so the attachment is the byte-for-byte file we fetched.
		const tool = new GithubTool(
			createSession(Settings.isolated({ "github.enabled": true, "images.autoResize": false })),
		);
		const result = await tool.execute("file-read", {
			op: "file_read",
			repo: "owner/repo",
			path: "docs/logo.png",
		});

		const text = textParts(result);
		expect(text).toContain("Image file: docs/logo.png");
		expect(text).toContain("MIME: image/png");
		expect(text).toContain(`Size: ${PNG_BYTES.byteLength}B`);
		expect(text).toContain("Dimensions: 3x2");

		const imagePart = result.content.find(part => part.type === "image") as
			| { type: "image"; data: string; mimeType: string }
			| undefined;
		expect(imagePart?.mimeType).toBe("image/png");
		expect(Buffer.from(imagePart?.data ?? "", "base64").equals(PNG_BYTES)).toBe(true);
	});

	it("reports a non-UTF-8 payload as binary instead of returning mojibake", async () => {
		const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81]);
		vi.spyOn(git.github, "json").mockResolvedValue(
			contentsResponse({
				content: binary.toBase64(),
				size: binary.byteLength,
				html_url: "https://github.com/owner/repo/blob/main/data.bin",
			}) as never,
		);

		const tool = new GithubTool(createSession());
		const result = await tool.execute("file-read", { op: "file_read", repo: "owner/repo", path: "data.bin" });

		const text = textParts(result);
		expect(text).toContain("Cannot read binary file 'data.bin'");
		expect(text).toContain(`${binary.byteLength}B`);
		expect(text).toContain("https://github.com/owner/repo/blob/main/data.bin");
		expect(result.content.some(part => part.type === "image")).toBe(false);
	});

	it("treats UTF-8 text with embedded NUL bytes as binary", async () => {
		const withNul = Buffer.from("PK\u0000\u0000archive", "utf8");
		vi.spyOn(git.github, "json").mockResolvedValue(
			contentsResponse({ content: withNul.toBase64(), size: withNul.byteLength }) as never,
		);

		const tool = new GithubTool(createSession());
		const text = textParts(await tool.execute("file-read", { op: "file_read", repo: "owner/repo", path: "a.zip" }));

		expect(text).toContain("Cannot read binary file 'a.zip'");
	});

	it("says the bytes never arrived when the API refuses to inline a large file", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue(
			contentsResponse({ encoding: "none", content: undefined, size: 2_500_000 }) as never,
		);

		const tool = new GithubTool(createSession());
		const text = textParts(
			await tool.execute("file-read", { op: "file_read", repo: "owner/repo", path: "big.json" }),
		);

		expect(text).toContain("did not return file bytes for 'big.json'");
		expect(text).toContain("2.4MB");
	});

	it("rejects a directory, an absolute path, and a missing path", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({ type: "dir", encoding: "none" } as never);
		const tool = new GithubTool(createSession());

		await expect(tool.execute("f", { op: "file_read", repo: "owner/repo", path: "src" })).rejects.toThrow(
			"GitHub path 'src' is not a file.",
		);
		await expect(tool.execute("f", { op: "file_read", repo: "owner/repo", path: "/etc/passwd" })).rejects.toThrow(
			"path must be repository-relative",
		);
		await expect(tool.execute("f", { op: "file_read", repo: "owner/repo" })).rejects.toThrow(
			"path must not be empty",
		);
	});

	it("names the failed request when the contents API errors", async () => {
		vi.spyOn(git.github, "json").mockRejectedValue(new ToolError("HTTP 404: Not Found"));

		const tool = new GithubTool(createSession());
		await expect(
			tool.execute("f", { op: "file_read", repo: "owner/repo", path: "missing.md", branch: "dev" }),
		).rejects.toThrow("GitHub file read failed for 'owner/repo@dev:missing.md': HTTP 404: Not Found");
	});

	it("does not swallow non-tool errors from the underlying command", async () => {
		vi.spyOn(git.github, "json").mockRejectedValue(new Error("spawn failed"));

		const tool = new GithubTool(createSession());
		await expect(tool.execute("f", { op: "file_read", repo: "owner/repo", path: "README.md" })).rejects.toThrow(
			"spawn failed",
		);
	});
});
