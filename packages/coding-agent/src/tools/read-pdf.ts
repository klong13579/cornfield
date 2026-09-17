/**
 * Render one page of a PDF as an image, using the Chromium this package
 * already resolves for the `puppeteer` tool ({@link loadPuppeteer} /
 * {@link ensureChromiumExecutable}).
 *
 * `read` reaches this through the `:<page>` suffix of a `.pdf` path
 * (`notes.pdf:p3`), which is a *different view of the same file*, not a line
 * selector: the file is rendered by Chromium's built-in PDF viewer and the
 * resulting bitmap is returned as an image attachment.
 *
 * Why the viewer's own DOM drives readiness: the PDF is painted by an
 * out-of-process frame that exposes nothing to the host document, so no DOM
 * signal in the main frame can tell "the page is on screen" from "the viewer
 * shell is on screen". The two signals read here are the viewer's own — its
 * toolbar drops `loading_` once the document has loaded, and the plugin
 * frame's `#sizer` spacer carries the laid-out page geometry — and the
 * capture waits for both to stop changing, because a capture taken while the
 * plugin frame is still rasterising returns a blank image that looks like a
 * legitimate render.
 */

import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Snowflake, untilAborted } from "@cornfield/utils";
import type { Browser, Page } from "puppeteer-core";
import { ensureChromiumExecutable, loadPuppeteer } from "./browser";
import { ToolAbortError, ToolError } from "./tool-errors";

/** Page suffix accepted on a `.pdf` read path: `:p3`, `:page3`, `:page-3`. */
const PDF_PAGE_SUFFIX_RE = /^(.*\.pdf):(?:p|page[-_]?)(\d+)$/i;

/** One-indexed page requested by a `file.pdf:<page>` read path. */
export interface PdfPageReadTarget {
	/** Everything before the suffix, as written by the caller. */
	pdfPath: string;
	page: number;
}

/**
 * Split a `file.pdf:p3` read path into its PDF and page parts. Returns
 * `null` for every other path — a `.pdf` read without a page suffix keeps
 * its existing markit text conversion.
 */
export function parsePdfPageReadPath(readPath: string): PdfPageReadTarget | null {
	const match = PDF_PAGE_SUFFIX_RE.exec(readPath);
	if (!match) return null;
	const pdfPath = match[1]!;
	if (pdfPath.length === 0) return null;
	return { pdfPath, page: Number.parseInt(match[2]!, 10) };
}

/** Render geometry. Portrait, near letter: the aspect most PDFs are authored at. */
const RENDER_WIDTH = 1024;
const RENDER_DEFAULT_HEIGHT = 1325;
const MIN_RENDER_HEIGHT = 400;
const MAX_RENDER_HEIGHT = 2000;
const DEVICE_SCALE_FACTOR = 1;

const NAV_TIMEOUT_MS = 20_000;
const LAYOUT_TIMEOUT_MS = 15_000;
const RENDER_TIMEOUT_MS = 45_000;
/** Consecutive identical geometry probes that count as "the layout settled". */
const STABLE_PROBES = 3;
const PROBE_INTERVAL_MS = 50;

/** A rendered PDF page on disk. */
export interface RenderedPdfPage {
	/** Absolute path of the PNG holding the rendered page. */
	filePath: string;
	/** The page that was rendered (1-indexed). */
	page: number;
	/** Total pages in the document, as reported by the viewer. */
	pageCount: number;
}

interface PluginGeometry {
	sizerWidth: number;
	sizerHeight: number;
	innerWidth: number;
	innerHeight: number;
	scrollY: number;
}

interface ViewerState {
	/** `null` when the viewer's toolbar is absent (older/other viewer builds). */
	loading: boolean | null;
	/** Total pages, `0` until the viewer has loaded the document. */
	pageCount: number;
}

interface PdfProbe {
	viewer: ViewerState;
	geometry: PluginGeometry | null;
}

/**
 * The subset of the page's globals these probes touch. The project compiles
 * without `lib.dom`, so the shape is declared locally rather than borrowed
 * from a DOM lib the rest of the package cannot use either.
 */
interface ProbeElement {
	clientWidth: number;
	clientHeight: number;
	textContent: string | null;
	hidden: boolean;
	hasAttribute(name: string): boolean;
	shadowRoot: { querySelector(selector: string): ProbeElement | null } | null;
}

interface ProbeGlobals {
	innerWidth: number;
	innerHeight: number;
	scrollY: number;
	document: {
		querySelector(selector: string): ProbeElement | null;
	};
}

/**
 * Read the viewer's load state and page count. Runs inside the page, so it
 * reads globals through the declared shape instead of module state.
 * Returns `null` when the frame being probed is not the viewer.
 */
function readViewerFrame(): ViewerState | null {
	const doc = (globalThis as unknown as ProbeGlobals).document;
	const viewer = doc.querySelector("pdf-viewer");
	if (!viewer) return null;
	const toolbar = viewer.shadowRoot?.querySelector("viewer-toolbar") ?? null;
	const length =
		toolbar?.shadowRoot?.querySelector("viewer-page-selector")?.shadowRoot?.querySelector("#pagelength") ?? null;
	const parsed = Number.parseInt(length?.textContent ?? "", 10);
	return {
		loading: toolbar ? toolbar.hasAttribute("loading_") : null,
		pageCount: Number.isFinite(parsed) ? parsed : 0,
	};
}

/**
 * Read the plugin frame's laid-out page geometry. `#sizer` is the spacer the
 * plugin sizes to the stacked pages, so its width is the page width and its
 * height covers every page plus the viewer's inter-page gaps. Returns `null`
 * when the frame being probed is not the plugin frame.
 */
function readPluginFrame(): PluginGeometry | null {
	const g = globalThis as unknown as ProbeGlobals;
	const sizer = g.document.querySelector("#sizer");
	if (!sizer || sizer.clientWidth <= 0) return null;
	return {
		sizerWidth: sizer.clientWidth,
		sizerHeight: sizer.clientHeight,
		innerWidth: g.innerWidth,
		innerHeight: g.innerHeight,
		scrollY: g.scrollY,
	};
}

/** Probe every frame; the viewer and the PDF plugin answer from different frames. */
async function probe(page: Page): Promise<PdfProbe> {
	const state: PdfProbe = { viewer: { loading: null, pageCount: 0 }, geometry: null };
	for (const frame of page.frames()) {
		try {
			const viewer = await frame.evaluate(readViewerFrame);
			if (viewer) {
				state.viewer = viewer;
				continue;
			}
			const geometry = await frame.evaluate(readPluginFrame);
			if (geometry) state.geometry = geometry;
		} catch {
			// A frame can be detached mid-probe (the viewer re-navigates itself);
			// the next probe sees its replacement.
		}
	}
	return state;
}

/** Hide the viewer's toolbar so it stays out of the rendered page. */
async function hideViewerToolbar(page: Page): Promise<void> {
	for (const frame of page.frames()) {
		try {
			const hidden = await frame.evaluate(() => {
				const doc = (globalThis as unknown as ProbeGlobals).document;
				const toolbar = doc.querySelector("pdf-viewer")?.shadowRoot?.querySelector("viewer-toolbar") ?? null;
				if (!toolbar) return false;
				toolbar.hidden = true;
				return true;
			});
			if (hidden) return;
		} catch {
			// Same detached-frame race as probe().
		}
	}
}

/**
 * Wait until `isSettled` holds across {@link STABLE_PROBES} consecutive
 * probes, so a caller never measures (or captures) a layout that is still
 * moving. Returns the last probe either way; the caller decides whether an
 * unsettled result is fatal.
 */
async function waitForStableLayout(
	page: Page,
	signal: AbortSignal,
	isSettled: (probe: PdfProbe) => boolean,
	timeoutMs: number,
): Promise<PdfProbe> {
	const deadline = Date.now() + timeoutMs;
	let previousKey: string | null = null;
	let stable = 0;
	let last: PdfProbe = { viewer: { loading: null, pageCount: 0 }, geometry: null };
	while (Date.now() < deadline) {
		last = await untilAborted(signal, () => probe(page));
		const g = last.geometry;
		const key = g
			? `${g.sizerWidth}|${g.sizerHeight}|${g.innerWidth}|${g.innerHeight}|${g.scrollY}|${last.viewer.loading}|${last.viewer.pageCount}`
			: null;
		stable = key !== null && key === previousKey ? stable + 1 : 0;
		previousKey = key;
		if (stable >= STABLE_PROBES && isSettled(last)) return last;
		await Bun.sleep(PROBE_INTERVAL_MS);
	}
	return last;
}

/**
 * Whether the requested page has been scrolled into view. `#sizer` covers
 * every page plus the viewer's inter-page gaps, so dividing by the page count
 * gives a page pitch that is at most the true one — the comparison is a floor
 * with a small tolerance, not an equality.
 */
function isPageInView(probe: PdfProbe, pageNumber: number): boolean {
	const geometry = probe.geometry;
	const pageCount = probe.viewer.pageCount;
	if (!geometry || pageCount < 1) return false;
	return geometry.scrollY >= (pageNumber - 1) * (geometry.sizerHeight / pageCount) - 6;
}

/**
 * Render `pageNumber` of `absolutePdfPath` to a PNG in the temp directory.
 *
 * Throws — never silently falls back to text — when the page cannot be
 * rendered: an out-of-range page, a file Chromium's PDF viewer will not
 * load, a browser that cannot be launched, or a render that runs out of time.
 */
export async function renderPdfPageToFile(
	absolutePdfPath: string,
	displayPath: string,
	pageNumber: number,
	signal?: AbortSignal,
): Promise<RenderedPdfPage> {
	// Rejected before anything is launched: a non-page would otherwise be handed
	// to the viewer, which clamps it to the first page and looks like success.
	if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
		throw new ToolError(
			`'${pageNumber}' is not a page of '${displayPath}': page numbers are 1-indexed (use ':p1' for the first page).`,
		);
	}

	const timeoutSignal = AbortSignal.timeout(RENDER_TIMEOUT_MS);
	const renderSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let browser: Browser | undefined;
	try {
		const puppeteer = await untilAborted(renderSignal, () => loadPuppeteer());
		const executablePath = await untilAborted(renderSignal, () => ensureChromiumExecutable());
		browser = await untilAborted(renderSignal, () =>
			puppeteer.launch({
				headless: true,
				executablePath,
				defaultViewport: {
					width: RENDER_WIDTH,
					height: RENDER_DEFAULT_HEIGHT,
					deviceScaleFactor: DEVICE_SCALE_FACTOR,
				},
				args: ["--disable-extensions", "--disable-default-apps"],
			}),
		);

		const handle = await browser.newPage();
		const url = pathToFileURL(absolutePdfPath);
		// `view=Fit` fits each page to the window, so the page fills whichever
		// axis binds once the viewport is matched to the page below.
		url.hash = `page=${pageNumber}&navpanes=0&view=Fit`;
		await untilAborted(renderSignal, () => handle.goto(url.href, { waitUntil: "load", timeout: NAV_TIMEOUT_MS }));

		// The toolbar is visible here because it is the only frame that reports
		// the load state and the page count; it is hidden before the capture.
		const initial = await waitForStableLayout(
			handle,
			renderSignal,
			p => p.viewer.loading === false && p.viewer.pageCount > 0 && isPageInView(p, pageNumber),
			LAYOUT_TIMEOUT_MS,
		);
		if (initial.viewer.loading !== false || initial.viewer.pageCount === 0 || !initial.geometry) {
			throw new ToolError(
				`Cannot render page ${pageNumber} of '${displayPath}': Chromium's PDF viewer never reported a loaded document. The file may not be a valid PDF.`,
			);
		}
		const pageCount = initial.viewer.pageCount;
		if (pageNumber > pageCount) {
			const plural = pageCount === 1 ? "page" : "pages";
			throw new ToolError(
				`Page ${pageNumber} is out of range: '${displayPath}' has ${pageCount} ${plural} (use ':p1' … ':p${pageCount}').`,
			);
		}

		// Match the window to the page so the capture is the page: with
		// `view=Fit` the page fills one axis exactly, and when the height is the
		// binding axis the page's own laid-out width over the window height is
		// its aspect. A page that binds the width instead is already as wide as
		// the window, so the default portrait window is kept.
		const initialGeometry = initial.geometry;
		const pageAspect =
			initialGeometry.sizerWidth < initialGeometry.innerWidth - 1
				? initialGeometry.sizerWidth / initialGeometry.innerHeight
				: RENDER_WIDTH / RENDER_DEFAULT_HEIGHT;
		const renderHeight = Math.max(
			MIN_RENDER_HEIGHT,
			Math.min(MAX_RENDER_HEIGHT, Math.round(RENDER_WIDTH / pageAspect)),
		);
		await hideViewerToolbar(handle);
		await handle.setViewport({
			width: RENDER_WIDTH,
			height: renderHeight,
			deviceScaleFactor: DEVICE_SCALE_FACTOR,
		});
		await waitForStableLayout(
			handle,
			renderSignal,
			p => p.geometry !== null && isPageInView(p, pageNumber),
			LAYOUT_TIMEOUT_MS,
		);

		const screenshot = await untilAborted(renderSignal, () => handle.screenshot({ type: "png" }));
		if (screenshot.byteLength === 0) {
			throw new ToolError(`Cannot render page ${pageNumber} of '${displayPath}': Chromium produced an empty image.`);
		}

		const filePath = path.join(os.tmpdir(), `cornfield-pdf-${Snowflake.next()}.png`);
		await Bun.write(filePath, screenshot);
		return { filePath, page: pageNumber, pageCount };
	} catch (error) {
		if (signal?.aborted) throw new ToolAbortError();
		if (timeoutSignal.aborted) {
			throw new ToolError(`Timed out rendering page ${pageNumber} of '${displayPath}' in Chromium.`);
		}
		if (error instanceof ToolError) throw error;
		throw new ToolError(
			`Cannot render page ${pageNumber} of '${displayPath}': ${
				error instanceof Error ? error.message : String(error)
			}. Reading the whole file (drop the ':p${pageNumber}' suffix) returns its extracted text instead.`,
		);
	} finally {
		await browser?.close().catch(() => {});
	}
}
