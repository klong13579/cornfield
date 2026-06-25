/**
 * Video extraction pipeline: regexes, stripping, and non-interference
 * with the image extraction pipeline.
 *
 * Contract: `![alt](/path.mp4)` / `![alt](https://...mp4)` in agent
 * reply text must be extracted as videos (not images), stripped from
 * the card body, and sent as standalone sampleVideo messages.
 */
import { describe, expect, test } from "bun:test";
import {
	extractLocalFileImages,
	extractLocalFileVideos,
	extractRemoteUrlImages,
	extractRemoteUrlVideos,
	stripImageDirectives,
	stripVideoDirectives,
} from "../src/channels/dingtalk";

// ═══════════════════════════════════════════════════════════════════════
// extractLocalFileVideos
// ═══════════════════════════════════════════════════════════════════════

describe("extractLocalFileVideos", () => {
	test("matches absolute path with .mp4 extension", () => {
		const text = "Here is the video: ![episode_85](/tmp/vid-085.mp4)";
		const result = extractLocalFileVideos(text);
		expect(result).toHaveLength(1);
		expect(result[0].path).toBe("/tmp/vid-085.mp4");
		expect(result[0].alt).toBe("episode_85");
	});

	test("matches file:// URI with .mp4 extension", () => {
		const text = "![demo](file:///tmp/demo.mp4)";
		const result = extractLocalFileVideos(text);
		expect(result).toHaveLength(1);
		expect(result[0].path).toBe("/tmp/demo.mp4");
		expect(result[0].alt).toBe("demo");
	});

	test("matches .mov, .webm, .avi, .mkv extensions", () => {
		const text = [
			"![a](/tmp/a.mov)",
			"![b](/tmp/b.webm)",
			"![c](/tmp/c.avi)",
			"![d](/tmp/d.mkv)",
		].join("\n");
		const result = extractLocalFileVideos(text);
		expect(result).toHaveLength(4);
		expect(result.map(v => v.path)).toEqual([
			"/tmp/a.mov",
			"/tmp/b.webm",
			"/tmp/c.avi",
			"/tmp/d.mkv",
		]);
	});

	test("does NOT match image extensions (png, jpg, etc.)", () => {
		const text = "![img](/tmp/screenshot.png) and ![vid](/tmp/clip.mp4)";
		const videos = extractLocalFileVideos(text);
		expect(videos).toHaveLength(1);
		expect(videos[0].path).toBe("/tmp/clip.mp4");
	});

	test("returns empty for text with no video markdown", () => {
		expect(extractLocalFileVideos("just plain text")).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// extractRemoteUrlVideos
// ═══════════════════════════════════════════════════════════════════════

describe("extractRemoteUrlVideos", () => {
	test("matches https URL with .mp4 extension", () => {
		const text = "![clip](https://example.com/video.mp4)";
		const result = extractRemoteUrlVideos(text);
		expect(result).toHaveLength(1);
		expect(result[0].url).toBe("https://example.com/video.mp4");
		expect(result[0].alt).toBe("clip");
	});

	test("matches URL with query string", () => {
		const text = "![v](https://cdn.example.com/vid.mp4?token=abc&expires=123)";
		const result = extractRemoteUrlVideos(text);
		expect(result).toHaveLength(1);
		expect(result[0].url).toBe("https://cdn.example.com/vid.mp4?token=abc&expires=123");
	});

	test("matches http:// URLs", () => {
		const text = "![v](http://example.com/clip.webm)";
		const result = extractRemoteUrlVideos(text);
		expect(result).toHaveLength(1);
		expect(result[0].url).toBe("http://example.com/clip.webm");
	});

	test("does NOT match image URLs (png, jpg, etc.)", () => {
		const text = "![img](https://example.com/pic.png) and ![vid](https://example.com/clip.mp4)";
		const videos = extractRemoteUrlVideos(text);
		expect(videos).toHaveLength(1);
		expect(videos[0].url).toBe("https://example.com/clip.mp4");
	});

	test("does NOT match non-video, non-image URLs", () => {
		const text = "![link](https://example.com/page.html)";
		expect(extractRemoteUrlVideos(text)).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// stripVideoDirectives
// ═══════════════════════════════════════════════════════════════════════

describe("stripVideoDirectives", () => {
	test("removes local file video markdown", () => {
		const text = "Before\n![vid](/tmp/clip.mp4)\nAfter";
		expect(stripVideoDirectives(text)).toBe("Before\n\nAfter");
	});

	test("removes remote URL video markdown", () => {
		const text = "Before\n![vid](https://example.com/clip.mp4)\nAfter";
		expect(stripVideoDirectives(text)).toBe("Before\n\nAfter");
	});

	test("preserves image markdown", () => {
		const text = "![img](/tmp/pic.png)\n![vid](/tmp/clip.mp4)";
		const stripped = stripVideoDirectives(text);
		expect(stripped).toBe("![img](/tmp/pic.png)");
	});

	test("collapses 3+ blank lines after removal", () => {
		const text = "A\n\n![vid](/tmp/clip.mp4)\n\n\n\nB";
		expect(stripVideoDirectives(text)).toBe("A\n\nB");
	});

	test("handles empty string", () => {
		expect(stripVideoDirectives("")).toBe("");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Non-interference: videos stripped before image extraction
// ═══════════════════════════════════════════════════════════════════════

describe("video/image pipeline non-interference", () => {
	test("stripping videos first prevents image extractor from grabbing video URLs", () => {
		const text = [
			"![image](https://example.com/pic.png)",
			"![video](https://example.com/clip.mp4)",
		].join("\n");

		// Step 1: strip videos (as streamCard does before image extraction)
		const textWithoutVideos = stripVideoDirectives(text);

		// Step 2: image extraction on cleaned text — should NOT pick up the .mp4
		const images = extractRemoteUrlImages(textWithoutVideos);
		expect(images).toHaveLength(1);
		expect(images[0].url).toBe("https://example.com/pic.png");

		// Step 3: video extraction on original text — both found
		const videos = extractRemoteUrlVideos(text);
		expect(videos).toHaveLength(1);
		expect(videos[0].url).toBe("https://example.com/clip.mp4");
	});

	test("local video and local image in same text are separated correctly", () => {
		const text = "![img](/tmp/screenshot.png)\n![vid](/tmp/clip.mp4)";

		const videos = extractLocalFileVideos(text);
		const textWithoutVideos = stripVideoDirectives(text);
		const images = extractLocalFileImages(textWithoutVideos);

		expect(videos).toHaveLength(1);
		expect(videos[0].path).toBe("/tmp/clip.mp4");
		expect(images).toHaveLength(1);
		expect(images[0].path).toBe("/tmp/screenshot.png");
	});

	test("mixed content: image stays in card, video goes standalone", () => {
		const text = [
			"Here's the analysis:",
			"![chart](/tmp/chart.png)",
			"",
			"And the recording:",
			"![recording](/tmp/session.mp4)",
			"",
			"Done.",
		].join("\n");

		const videos = extractLocalFileVideos(text);
		const textWithoutVideos = stripVideoDirectives(text);
		const images = extractLocalFileImages(textWithoutVideos);
		const finalText = stripImageDirectives(textWithoutVideos);

		expect(videos).toHaveLength(1);
		expect(videos[0].path).toBe("/tmp/session.mp4");
		expect(images).toHaveLength(1);
		expect(images[0].path).toBe("/tmp/chart.png");
		expect(finalText).toContain("Here's the analysis:");
		expect(finalText).toContain("And the recording:");
		expect(finalText).toContain("Done.");
		expect(finalText).not.toContain("chart.png");
		expect(finalText).not.toContain("session.mp4");
	});
});
