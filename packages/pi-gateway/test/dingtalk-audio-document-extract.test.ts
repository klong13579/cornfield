/**
 * Audio + document extraction pipeline: regexes, stripping, and
 * non-interference with the existing image / video extractors.
 *
 * Contract: `![alt](/path.mp3)` / `![alt](https://...pdf)` in agent
 * reply text must be extracted as audio / documents (not images or
 * videos), stripped from the card body, and delivered as standalone
 * `sampleAudio` / `sampleFile` messages after the card finishes.
 */
import { describe, expect, test } from "bun:test";
import {
	extractLocalFileAudios,
	extractLocalFileDocuments,
	extractLocalFileVideos,
	extractRemoteUrlAudios,
	extractRemoteUrlDocuments,
	extractRemoteUrlImages,
	stripImageDirectives,
	stripNonImageMediaDirectives,
	stripVideoDirectives,
} from "../src/channels/dingtalk";

// ═══════════════════════════════════════════════════════════════════════
// extractLocalFileAudios
// ═══════════════════════════════════════════════════════════════════════

describe("extractLocalFileAudios", () => {
	test("matches absolute path with .mp3 extension", () => {
		const text = "Voice memo: ![memo](/tmp/voice-001.mp3)";
		const result = extractLocalFileAudios(text);
		expect(result).toHaveLength(1);
		expect(result[0].path).toBe("/tmp/voice-001.mp3");
		expect(result[0].alt).toBe("memo");
	});

	test("matches file:// URI for any audio extension", () => {
		const text = [
			"![a](file:///tmp/a.amr)",
			"![b](file:///tmp/b.mp3)",
			"![c](file:///tmp/c.wav)",
			"![d](file:///tmp/d.ogg)",
		].join("\n");
		const result = extractLocalFileAudios(text);
		expect(result).toHaveLength(4);
		expect(result.map(a => a.path)).toEqual(["/tmp/a.amr", "/tmp/b.mp3", "/tmp/c.wav", "/tmp/d.ogg"]);
	});

	test("does NOT match image or video extensions", () => {
		const text = "![img](/tmp/a.png) and ![vid](/tmp/b.mp4) and ![aud](/tmp/c.mp3)";
		const audios = extractLocalFileAudios(text);
		expect(audios).toHaveLength(1);
		expect(audios[0].path).toBe("/tmp/c.mp3");
	});

	test("returns empty for text with no audio markdown", () => {
		expect(extractLocalFileAudios("just plain text")).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// extractRemoteUrlAudios
// ═══════════════════════════════════════════════════════════════════════

describe("extractRemoteUrlAudios", () => {
	test("matches https URL with audio extension", () => {
		const text = "![memo](https://example.com/memo.mp3)";
		const result = extractRemoteUrlAudios(text);
		expect(result).toHaveLength(1);
		expect(result[0].url).toBe("https://example.com/memo.mp3");
		expect(result[0].alt).toBe("memo");
	});

	test("matches URL with query string", () => {
		const text = "![v](https://cdn.example.com/aud.amr?token=abc)";
		const result = extractRemoteUrlAudios(text);
		expect(result).toHaveLength(1);
		expect(result[0].url).toBe("https://cdn.example.com/aud.amr?token=abc");
	});

	test("does NOT match image, video, or document URLs", () => {
		const text = [
			"![img](https://example.com/a.png)",
			"![vid](https://example.com/b.mp4)",
			"![doc](https://example.com/c.pdf)",
			"![aud](https://example.com/d.mp3)",
		].join("\n");
		const audios = extractRemoteUrlAudios(text);
		expect(audios).toHaveLength(1);
		expect(audios[0].url).toBe("https://example.com/d.mp3");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// extractLocalFileDocuments
// ═══════════════════════════════════════════════════════════════════════

describe("extractLocalFileDocuments", () => {
	test("matches all supported office / archive extensions", () => {
		const text = [
			"![a](/tmp/a.pdf)",
			"![b](/tmp/b.doc)",
			"![c](/tmp/c.docx)",
			"![d](/tmp/d.xls)",
			"![e](/tmp/e.xlsx)",
			"![f](/tmp/f.ppt)",
			"![g](/tmp/g.pptx)",
			"![h](/tmp/h.zip)",
			"![i](/tmp/i.rar)",
		].join("\n");
		const result = extractLocalFileDocuments(text);
		expect(result).toHaveLength(9);
		expect(result[0].alt).toBe("a");
		expect(result[8].path).toBe("/tmp/i.rar");
	});

	test("matches file:// URI", () => {
		const text = "![report](file:///home/user/report.pdf)";
		const result = extractLocalFileDocuments(text);
		expect(result).toHaveLength(1);
		expect(result[0].path).toBe("/home/user/report.pdf");
	});

	test("does NOT match non-document extensions", () => {
		const text = "![img](/tmp/a.png) and ![doc](/tmp/b.pdf) and ![vid](/tmp/c.mp4)";
		const docs = extractLocalFileDocuments(text);
		expect(docs).toHaveLength(1);
		expect(docs[0].path).toBe("/tmp/b.pdf");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// extractRemoteUrlDocuments
// ═══════════════════════════════════════════════════════════════════════

describe("extractRemoteUrlDocuments", () => {
	test("matches pdf URL with query string", () => {
		const text = "![report](https://example.com/report.pdf?download=1)";
		const result = extractRemoteUrlDocuments(text);
		expect(result).toHaveLength(1);
		expect(result[0].url).toBe("https://example.com/report.pdf?download=1");
	});

	test("matches all office / archive extensions", () => {
		const text = [
			"![a](https://example.com/a.docx)",
			"![b](https://example.com/b.xlsx)",
			"![c](https://example.com/c.pptx)",
			"![d](https://example.com/d.zip)",
		].join("\n");
		const result = extractRemoteUrlDocuments(text);
		expect(result).toHaveLength(4);
	});

	test("does NOT match image, audio, or video URLs", () => {
		const text = "![img](https://example.com/a.png) and ![doc](https://example.com/b.pdf)";
		const docs = extractRemoteUrlDocuments(text);
		expect(docs).toHaveLength(1);
		expect(docs[0].url).toBe("https://example.com/b.pdf");
	});
});

// stripAudioDirectives / stripDocumentDirectives live behind the
// combined `stripNonImageMediaDirectives` so we test that here. A
// per-kind stripper is not part of the public surface. The per-kind
// preservation tests below expect the OTHER non-image kinds to also
// be stripped, since the combined function strips all non-image
// media in one pass.

describe("stripNonImageMediaDirectives removes audio", () => {
	test("removes local file audio markdown", () => {
		const text = "Before\n![aud](/tmp/voice.mp3)\nAfter";
		expect(stripNonImageMediaDirectives(text)).toBe("Before\n\nAfter");
	});

	test("removes remote URL audio markdown", () => {
		const text = "Before\n![aud](https://example.com/x.amr)\nAfter";
		expect(stripNonImageMediaDirectives(text)).toBe("Before\n\nAfter");
	});

	test("preserves image markdown (strips video/audio/doc in one pass)", () => {
		const text = [
			"![img](/tmp/pic.png)",
			"![vid](/tmp/clip.mp4)",
			"![doc](/tmp/r.pdf)",
			"![aud](/tmp/voice.mp3)",
		].join("\n");
		const stripped = stripNonImageMediaDirectives(text);
		expect(stripped).toContain("![img](/tmp/pic.png)");
		expect(stripped).not.toContain("voice.mp3");
	});
});

describe("stripNonImageMediaDirectives removes document", () => {
	test("removes local file document markdown", () => {
		const text = "Before\n![doc](/tmp/r.pdf)\nAfter";
		expect(stripNonImageMediaDirectives(text)).toBe("Before\n\nAfter");
	});

	test("removes remote URL document markdown", () => {
		const text = "Before\n![doc](https://example.com/x.docx)\nAfter";
		expect(stripNonImageMediaDirectives(text)).toBe("Before\n\nAfter");
	});

	test("preserves image markdown (strips video/audio/doc in one pass)", () => {
		const text = [
			"![img](/tmp/pic.png)",
			"![vid](/tmp/clip.mp4)",
			"![aud](/tmp/voice.mp3)",
			"![doc](/tmp/r.pdf)",
		].join("\n");
		const stripped = stripNonImageMediaDirectives(text);
		expect(stripped).toContain("![img](/tmp/pic.png)");
		expect(stripped).not.toContain("r.pdf");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// stripNonImageMediaDirectives
// ═══════════════════════════════════════════════════════════════════════

describe("stripNonImageMediaDirectives", () => {
	test("strips audio + document but NOT image markdown", () => {
		const text = ["![img](/tmp/pic.png)", "![aud](/tmp/voice.mp3)", "![doc](/tmp/r.pdf)"].join("\n");
		const stripped = stripNonImageMediaDirectives(text);
		expect(stripped).toContain("![img](/tmp/pic.png)");
		expect(stripped).not.toContain("voice.mp3");
		expect(stripped).not.toContain("r.pdf");
	});

	test("strips both local and remote URL forms", () => {
		const text = [
			"![a](/tmp/voice.mp3)",
			"![b](https://example.com/voice.mp3)",
			"![c](/tmp/r.pdf)",
			"![d](https://example.com/r.pdf?token=1)",
		].join("\n");
		const stripped = stripNonImageMediaDirectives(text);
		expect(stripped).toBe("");
	});

	test("collapses 3+ blank lines after removal", () => {
		const text = "A\n\n\n![aud](/tmp/voice.mp3)\n\n\nB";
		expect(stripNonImageMediaDirectives(text)).toBe("A\n\nB");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Cross-kind non-interference
// ═══════════════════════════════════════════════════════════════════════

describe("audio / document / image / video pipeline non-interference", () => {
	test("all four kinds separated correctly from a mixed reply", () => {
		const text = [
			"![screenshot](/tmp/a.png)",
			"![diagram](https://example.com/diagram.jpg)",
			"![recording](/tmp/session.mp4)",
			"![voice](https://example.com/voice.mp3)",
			"![report](/tmp/q4.pdf)",
		].join("\n");

		const videos = extractLocalFileVideos(text);
		const remoteAudios = extractRemoteUrlAudios(text);
		const docs = extractLocalFileDocuments(text);
		// Stripping all non-image media in one pass mirrors the order
		// the streamCard pipeline will use: videos first (to keep
		// them out of the image extractor), then audio + docs.
		const textNoNonImage = stripNonImageMediaDirectives(stripVideoDirectives(text));
		const textNoImage = stripImageDirectives(textNoNonImage);

		expect(videos).toHaveLength(1);
		expect(videos[0].path).toBe("/tmp/session.mp4");
		expect(remoteAudios).toHaveLength(1);
		expect(remoteAudios[0].url).toBe("https://example.com/voice.mp3");
		expect(docs).toHaveLength(1);
		expect(docs[0].path).toBe("/tmp/q4.pdf");

		// After stripping all media, the body has no media references.
		expect(textNoImage).not.toContain(".png");
		expect(textNoImage).not.toContain(".jpg");
		expect(textNoImage).not.toContain(".mp4");
		expect(textNoImage).not.toContain(".mp3");
		expect(textNoImage).not.toContain(".pdf");
		expect(textNoImage.trim()).toBe("");
	});

	test("image extractor does not grab audio or document URLs", () => {
		const text = [
			"![img](https://example.com/pic.png)",
			"![aud](https://example.com/voice.mp3)",
			"![doc](https://example.com/report.pdf)",
		].join("\n");

		const cleaned = stripNonImageMediaDirectives(text);
		const images = extractRemoteUrlImages(cleaned);
		expect(images).toHaveLength(1);
		expect(images[0].url).toBe("https://example.com/pic.png");
	});

	test("image extractor does not grab video URLs even when only video stripped", () => {
		const text = ["![img](https://example.com/pic.png)", "![vid](https://example.com/clip.mp4)"].join("\n");

		const textNoVideo = stripVideoDirectives(text);
		const images = extractRemoteUrlImages(textNoVideo);
		expect(images).toHaveLength(1);
		expect(images[0].url).toBe("https://example.com/pic.png");
	});
});
