import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/sdk";
import { ReadTool } from "../../src/tools/read";
import { parsePdfPageReadPath, renderPdfPageToFile } from "../../src/tools/read-pdf";

/**
 * `read <file.pdf>:pN` names a *view* of the file — one rendered page — not a
 * line range of its extracted text. The suffix parser and the argument
 * validation are pure, so they are covered here; the render itself needs a
 * real Chromium, and is covered by the suite at the bottom of this file only
 * when one is already installed (the resolver downloads Chromium when it is
 * not, and a test suite must not hit the network).
 */
describe("pdf page read path", () => {
	it("splits the page suffix off a pdf path", () => {
		expect(parsePdfPageReadPath("notes.pdf:p3")).toEqual({ pdfPath: "notes.pdf", page: 3 });
		expect(parsePdfPageReadPath("docs/report.PDF:page12")).toEqual({ pdfPath: "docs/report.PDF", page: 12 });
		expect(parsePdfPageReadPath("a b/x.pdf:page-4")).toEqual({ pdfPath: "a b/x.pdf", page: 4 });
		expect(parsePdfPageReadPath("x.pdf:page_4")).toEqual({ pdfPath: "x.pdf", page: 4 });
	});

	it("leaves every other path alone", () => {
		expect(parsePdfPageReadPath("x.pdf")).toBeNull();
		expect(parsePdfPageReadPath("x.pdf:")).toBeNull();
		expect(parsePdfPageReadPath("x.pdf:p")).toBeNull();
		expect(parsePdfPageReadPath("x.pdf:p2x")).toBeNull();
		expect(parsePdfPageReadPath("x.txt:p2")).toBeNull();
		expect(parsePdfPageReadPath(":p3")).toBeNull();
		expect(parsePdfPageReadPath("x.pdf:p2:conflicts")).toBeNull();
	});

	it("accepts p0 as a page number and leaves rejecting it to the renderer", () => {
		// The parser answers "is this a page request", not "is this a valid page":
		// `:p0` is a page request whose page does not exist, and the caller's error
		// message has to say that rather than "path not found".
		expect(parsePdfPageReadPath("x.pdf:p0")).toEqual({ pdfPath: "x.pdf", page: 0 });
	});
});

describe("pdf page read", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-pdf-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function makeTool(): ReadTool {
		const session = {
			cwd: tmpDir,
			hasEditTool: false,
			settings: Settings.isolated({ "read.defaultLimit": 3000, readLineNumbers: false }),
		} as unknown as ToolSession;
		return new ReadTool(session);
	}

	it("rejects a page number below 1 before starting a browser", async () => {
		await Bun.write(path.join(tmpDir, "doc.pdf"), "%PDF-1.4\n%%EOF\n");
		expect(makeTool().execute("c", { path: "doc.pdf:p0" })).rejects.toThrow(/page numbers are 1-indexed/);
	});

	it("rejects a page suffix combined with a line selector", async () => {
		await Bun.write(path.join(tmpDir, "doc.pdf"), "%PDF-1.4\n%%EOF\n");
		expect(makeTool().execute("c", { path: "doc.pdf:p2", sel: "1-5" })).rejects.toThrow(
			/Cannot combine ':p2' with a selector/,
		);
	});

	it("resolves the pdf before the page, so a missing pdf reports the path", async () => {
		expect(makeTool().execute("c", { path: "missing.pdf:p2" })).rejects.toThrow(/Path 'missing\.pdf' not found/);
	});

	it("reports a directory named like a pdf instead of rendering it", async () => {
		await fs.mkdir(path.join(tmpDir, "trap.pdf"), { recursive: true });
		expect(makeTool().execute("c", { path: "trap.pdf:p1" })).rejects.toThrow(/is a directory, not a PDF/);
	});

	it("does not treat a page suffix on a non-pdf path as a page request", async () => {
		await Bun.write(path.join(tmpDir, "notes.txt"), "hello\n");
		expect(makeTool().execute("c", { path: "notes.txt:p2" })).rejects.toThrow(/Path 'notes.txt:p2' not found/);
	});
});

/**
 * A minimal, valid PDF with `pageCount` pages, each carrying its own number as
 * text. Written by hand so the render suite needs no PDF library.
 */
function buildPdf(pageCount: number): Uint8Array {
	const bodies = new Map<number, string>();
	const kids: number[] = [];
	let next = 3;
	for (let i = 0; i < pageCount; i++) {
		const pageObj = next++;
		const contentObj = next++;
		kids.push(pageObj);
		const content = `BT /F1 36 Tf 72 700 Td (Page ${i + 1} of ${pageCount}) Tj ET\n`;
		bodies.set(
			pageObj,
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObj} 0 R /Resources << /Font << /F1 9 0 R >> >> >>`,
		);
		bodies.set(contentObj, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
	}
	bodies.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
	bodies.set(2, `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${pageCount} >>`);
	bodies.set(9, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

	const parts: string[] = ["%PDF-1.4\n"];
	const offsets = new Map<number, number>();
	let length = Buffer.byteLength(parts[0]!);
	for (const num of [...bodies.keys()].sort((a, b) => a - b)) {
		offsets.set(num, length);
		const text = `${num} 0 obj\n${bodies.get(num)}\nendobj\n`;
		parts.push(text);
		length += Buffer.byteLength(text);
	}
	const xrefOffset = length;
	const maxObj = Math.max(...bodies.keys());
	parts.push(`xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`);
	for (let num = 1; num <= maxObj; num++) {
		const offset = offsets.get(num);
		parts.push(offset === undefined ? "0000000000 65535 f \n" : `${String(offset).padStart(10, "0")} 00000 n \n`);
	}
	parts.push(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
	return new TextEncoder().encode(parts.join(""));
}

const CHROME_CANDIDATES = [
	process.env.PUPPETEER_EXECUTABLE_PATH,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
];
// Rendering is covered only where a browser already exists: resolving one is a
// download, and the default suite must not fetch anything.
const localChrome = CHROME_CANDIDATES.find(candidate => candidate && existsSync(candidate));
const describeRender = localChrome ? describe : describe.skip;

describeRender("pdf page rendering (local Chromium)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-pdf-render-"));
		await Bun.write(path.join(tmpDir, "three.pdf"), buildPdf(3));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function makeTool(): ReadTool {
		const session = {
			cwd: tmpDir,
			hasEditTool: false,
			settings: Settings.isolated({ "read.defaultLimit": 3000, readLineNumbers: false }),
		} as unknown as ToolSession;
		return new ReadTool(session);
	}

	it("renders a page to a png and reports the document's page count", async () => {
		const rendered = await renderPdfPageToFile(path.join(tmpDir, "three.pdf"), "three.pdf", 2, undefined);
		expect(rendered.page).toBe(2);
		expect(rendered.pageCount).toBe(3);
		const bits = await fs.readFile(rendered.filePath);
		// PNG magic: a viewer shell or a blank surface is still a PNG, so the
		// byte length is the part that proves the page was painted.
		expect([...bits.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect(bits.byteLength).toBeGreaterThan(4000);
		await fs.rm(rendered.filePath, { force: true });
	}, 60_000);

	it("names the page count when the requested page does not exist", async () => {
		expect(renderPdfPageToFile(path.join(tmpDir, "three.pdf"), "three.pdf", 4, undefined)).rejects.toThrow(
			/Page 4 is out of range: 'three.pdf' has 3 pages/,
		);
	}, 60_000);

	it("returns the rendered page as a text note plus an image attachment", async () => {
		const result = await makeTool().execute("c", { path: "three.pdf:p1" });
		const text = result.content.find(block => block.type === "text");
		const image = result.content.find(block => block.type === "image");
		expect(text && text.type === "text" ? text.text : "").toContain("Rendered page 1 of 3 of three.pdf");
		expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(typeof (image as { data?: string }).data).toBe("string");
		expect((image as { data: string }).data.length).toBeGreaterThan(1000);
		expect(result.details?.resolvedPath).toBe(path.join(tmpDir, "three.pdf"));
	}, 60_000);
});
