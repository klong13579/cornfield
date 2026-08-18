import { copyText } from "./copy";

/**
 * mermaid SVG 查看器 —— 纯 DOM 命令式实现（port of hermes ui.js
 * `_mountMermaidViewer` / `_openMermaidLightbox`，约 ui.js:1970-2434）。
 *
 * 与 React 解耦：`mountMermaidViewer` 接收已渲染的 `<svg>`，包一层
 * toolbar + viewport + canvas，做 scale/translate（zoom / pan / fit / 全屏）。
 * 返回 handle，React 层负责在卸载时 `destroy()`。
 *
 * 交互规格（同 ui.js）：
 * - 滚轮缩放（锚在光标）、指针拖拽平移、双指捏合
 * - toolbar：zoom in / zoom out / reset / fit / fullscreen（inline 才带最后一个）
 * - inline 单击（非拖拽）打开全屏 lightbox；lightbox 克隆 SVG 并重映射 id 防冲突
 */

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.2;
const INLINE_MIN_HEIGHT = 220;

type Mode = "inline" | "lightbox";
type IconKind = "zoomIn" | "zoomOut" | "reset" | "fit" | "fullscreen" | "copy" | "check";

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ViewerHandle {
	root: HTMLDivElement;
	destroy(): void;
}

interface LightboxHandle {
	el: HTMLDivElement;
	close(): void;
}

function icon(kind: IconKind): string {
	const icons: Record<IconKind, string> = {
		zoomIn:
			'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6"></circle><path d="M10 7v6M7 10h6"></path><path d="M15 15l4 4"></path></svg>',
		zoomOut:
			'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6"></circle><path d="M7 10h6"></path><path d="M15 15l4 4"></path></svg>',
		reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9V4H1"></path><path d="M1 4l4 4"></path><path d="M10 4a8 8 0 1 1-5.66 13.66"></path></svg>',
		fit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"></path></svg>',
		fullscreen:
			'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"></path><path d="M4 4l5 5M20 4l-5 5M4 20l5-5M20 20l-5-5"></path></svg>',
		copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V7a2 2 0 0 1 2-2h8"></path></svg>',
		check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"></path></svg>',
	};
	return icons[kind] ?? "";
}

function createButton(label: string, kind: IconKind, onClick: () => void): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "mermaid-viewer-btn";
	btn.setAttribute("aria-label", label);
	btn.setAttribute("title", label);
	btn.innerHTML = icon(kind);
	btn.onclick = e => {
		e.preventDefault();
		e.stopPropagation();
		onClick();
	};
	return btn;
}

function addCopySourceButton(toolbar: HTMLDivElement, source: string): void {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "mermaid-viewer-btn";
	btn.setAttribute("aria-label", "复制源码");
	btn.setAttribute("aria-live", "polite");
	btn.title = "复制源码";
	btn.innerHTML = icon("copy");
	let resetTimer: ReturnType<typeof setTimeout> | null = null;
	btn.onclick = e => {
		e.preventDefault();
		e.stopPropagation();
		void copyText(source).then(ok => {
			if (!ok) return;
			btn.innerHTML = icon("check");
			btn.title = "已复制";
			btn.setAttribute("aria-label", "源码已复制");
			if (resetTimer) clearTimeout(resetTimer);
			resetTimer = setTimeout(() => {
				btn.innerHTML = icon("copy");
				btn.title = "复制源码";
				btn.setAttribute("aria-label", "复制源码");
				resetTimer = null;
			}, 1500);
		});
	};
	toolbar.appendChild(btn);
}

function svgBox(svgEl: SVGSVGElement): Box {
	const box: Box = { x: 0, y: 0, width: 0, height: 0 };
	if (!svgEl) return box;

	const vb = svgEl.viewBox?.baseVal;
	if (vb?.width && vb.height) {
		box.x = Number(vb.x) || 0;
		box.y = Number(vb.y) || 0;
		box.width = Number(vb.width) || 0;
		box.height = Number(vb.height) || 0;
		return box;
	}

	const raw = svgEl.getAttribute?.("viewBox");
	if (raw) {
		const parts = raw
			.trim()
			.split(/[,\s]+/)
			.map(Number);
		if (parts.length >= 4 && parts.every(n => Number.isFinite(n))) {
			box.x = parts[0] || 0;
			box.y = parts[1] || 0;
			box.width = parts[2] || 0;
			box.height = parts[3] || 0;
			return box;
		}
	}

	const width = Number.parseFloat(svgEl.getAttribute?.("width") ?? "") || svgEl.getBoundingClientRect?.()?.width || 0;
	const height =
		Number.parseFloat(svgEl.getAttribute?.("height") ?? "") || svgEl.getBoundingClientRect?.()?.height || 0;
	box.width = width || 800;
	box.height = height || 450;
	return box;
}

interface ViewerState {
	box: Box;
	canvas: HTMLDivElement;
	dragging: boolean;
	dragged: boolean;
	dragOriginX: number;
	dragOriginY: number;
	dragPointerId: number | null;
	dragStartX: number;
	dragStartY: number;
	fitScale: number;
	lightbox: HTMLDivElement | null;
	lightboxClose: (() => void) | null;
	mode: Mode;
	onResize: (() => void) | null;
	pinching: boolean;
	pinchStartDist: number;
	pinchStartScale: number;
	pinchStartCX: number;
	pinchStartCY: number;
	pinchStartX: number;
	pinchStartY: number;
	resizeTimer: ReturnType<typeof setTimeout> | null;
	root: HTMLDivElement;
	scale: number;
	svg: SVGSVGElement;
	viewport: HTMLDivElement;
	x: number;
	y: number;
}

export function mountMermaidViewer(
	svgEl: SVGSVGElement,
	options: { mode: Mode; source?: string },
): ViewerHandle | null {
	if (!svgEl) return null;

	const mode: Mode = options.mode === "lightbox" ? "lightbox" : "inline";
	const box = svgBox(svgEl);
	const host = svgEl.parentNode;

	const root = document.createElement("div");
	root.className = `mermaid-viewer mermaid-viewer--${mode}`;
	const toolbar = document.createElement("div");
	toolbar.className = "mermaid-viewer-toolbar";
	const viewport = document.createElement("div");
	viewport.className = "mermaid-viewer-viewport";
	const canvas = document.createElement("div");
	canvas.className = "mermaid-viewer-canvas";
	canvas.style.width = `${Math.max(1, Math.round(box.width))}px`;
	canvas.style.height = `${Math.max(1, Math.round(box.height))}px`;

	svgEl.classList.add("mermaid-viewer-svg");
	if (mode === "lightbox") svgEl.classList.add("mermaid-lightbox-svg");
	svgEl.style.width = "100%";
	svgEl.style.height = "100%";
	svgEl.style.display = "block";

	viewport.appendChild(canvas);
	root.appendChild(toolbar);
	root.appendChild(viewport);
	if (host) host.replaceChild(root, svgEl);
	canvas.appendChild(svgEl);

	const state: ViewerState = {
		box,
		canvas,
		dragging: false,
		dragged: false,
		dragOriginX: 0,
		dragOriginY: 0,
		dragPointerId: null,
		dragStartX: 0,
		dragStartY: 0,
		fitScale: 1,
		lightbox: null,
		lightboxClose: null,
		mode,
		onResize: null,
		pinching: false,
		pinchStartDist: 0,
		pinchStartScale: 1,
		pinchStartCX: 0,
		pinchStartCY: 0,
		pinchStartX: 0,
		pinchStartY: 0,
		resizeTimer: null,
		root,
		scale: 1,
		svg: svgEl,
		viewport,
		x: 0,
		y: 0,
	};

	function lightboxEnvelope() {
		const width = Math.round((window.innerWidth || box.width) * 0.9);
		const height = Math.round((window.innerHeight || box.height) * 0.9);
		return {
			width: Math.max(1, Number.isFinite(width) ? width : 1),
			height: Math.max(1, Number.isFinite(height) ? height : 1),
		};
	}

	function viewportFallbackSize() {
		if (mode === "lightbox") return lightboxEnvelope();
		const width = Math.round(window.innerWidth || box.width);
		const height = Math.round((window.innerHeight || box.height) * 0.7);
		return {
			width: Math.max(1, Number.isFinite(width) ? width : 1),
			height: Math.max(1, Number.isFinite(height) ? height : 1),
		};
	}

	function viewportSize() {
		const rect = viewport.getBoundingClientRect?.() ?? null;
		const width =
			mode === "lightbox"
				? lightboxEnvelope().width
				: viewport.clientWidth || rect?.width || viewportFallbackSize().width;
		const height =
			mode === "lightbox"
				? lightboxEnvelope().height
				: viewport.clientHeight || rect?.height || viewportFallbackSize().height;
		return {
			width: Math.max(1, Number(width) || box.width || 1),
			height: Math.max(1, Number(height) || box.height || 1),
		};
	}

	function rawFitScale(size: { width: number; height: number }) {
		return Math.min(size.width / Math.max(1, box.width), size.height / Math.max(1, box.height));
	}

	function inlineViewportHeight() {
		const size = viewportSize();
		const widthFitScale = size.width / Math.max(1, box.width);
		const widthBasedHeight = Math.max(1, Math.round(box.height * widthFitScale));
		const fallback = viewportFallbackSize();
		return Math.min(fallback.height, Math.max(INLINE_MIN_HEIGHT, widthBasedHeight));
	}

	function minScale() {
		if (mode === "lightbox") return Math.min(MIN_SCALE, rawFitScale(viewportSize()));
		return Math.min(MIN_SCALE, inlineViewportHeight() / Math.max(1, box.height));
	}

	function applyTransform() {
		canvas.style.transform = `translate(${Math.round(state.x)}px, ${Math.round(state.y)}px) scale(${state.scale})`;
		canvas.style.transformOrigin = "0 0";
	}

	function centerForScale(nextScale: number) {
		const size = viewportSize();
		const scaledWidth = box.width * nextScale;
		const scaledHeight = box.height * nextScale;
		state.x = scaledWidth < size.width ? Math.round((size.width - scaledWidth) / 2) : 0;
		state.y = scaledHeight < size.height ? Math.round((size.height - scaledHeight) / 2) : 0;
	}

	function fitScale() {
		const size = viewportSize();
		return Math.max(minScale(), Math.min(MAX_SCALE, rawFitScale(size)));
	}

	function setScale(nextScale: number, anchorX?: number, anchorY?: number) {
		const bounded = Math.max(minScale(), Math.min(MAX_SCALE, nextScale));
		if (!Number.isFinite(bounded) || !box.width || !box.height) return;
		const focusX = typeof anchorX === "number" && Number.isFinite(anchorX) ? anchorX : viewportSize().width / 2;
		const focusY = typeof anchorY === "number" && Number.isFinite(anchorY) ? anchorY : viewportSize().height / 2;
		if (state.scale) {
			const ratio = bounded / state.scale;
			state.x = focusX - (focusX - state.x) * ratio;
			state.y = focusY - (focusY - state.y) * ratio;
		}
		state.scale = bounded;
		applyTransform();
	}

	function fitViewer() {
		const nextScale = fitScale();
		state.fitScale = nextScale;
		state.scale = nextScale;
		centerForScale(nextScale);
		applyTransform();
	}

	function resetViewer() {
		state.scale = 1;
		centerForScale(1);
		applyTransform();
	}

	function zoomIn() {
		const size = viewportSize();
		setScale(state.scale * ZOOM_STEP, size.width / 2, size.height / 2);
	}

	function zoomOut() {
		const size = viewportSize();
		setScale(state.scale / ZOOM_STEP, size.width / 2, size.height / 2);
	}

	function zoomFromWheel(e: WheelEvent) {
		e.preventDefault();
		const rect = viewport.getBoundingClientRect?.() ?? { left: 0, top: 0 };
		const anchorX = Number.isFinite(e.clientX) ? e.clientX - rect.left : undefined;
		const anchorY = Number.isFinite(e.clientY) ? e.clientY - rect.top : undefined;
		const deltaMode = Number(e.deltaMode) || 0;
		const lineScale = deltaMode === 1 ? 30 : deltaMode === 2 ? 600 : 1;
		const factor = Math.exp(-(Number(e.deltaY) || 0) * lineScale * 0.0015);
		setScale(state.scale * factor, anchorX, anchorY);
	}

	function onPointerDown(e: PointerEvent) {
		if (state.pinching) return;
		if (e.button != null && e.button !== 0) return;
		state.dragging = true;
		state.dragged = false;
		state.dragStartX = state.x;
		state.dragStartY = state.y;
		state.dragPointerId = e.pointerId ?? null;
		state.dragOriginX = Number(e.clientX) || 0;
		state.dragOriginY = Number(e.clientY) || 0;
		viewport.classList.add("is-panning");
		if (state.dragPointerId != null && viewport.setPointerCapture) viewport.setPointerCapture(state.dragPointerId);
		e.preventDefault();
	}

	function onPointerMove(e: PointerEvent) {
		if (state.pinching) return;
		if (!state.dragging) return;
		const dx = (Number(e.clientX) || 0) - state.dragOriginX;
		const dy = (Number(e.clientY) || 0) - state.dragOriginY;
		if (Math.abs(dx) + Math.abs(dy) > 3) state.dragged = true;
		state.x = state.dragStartX + dx;
		state.y = state.dragStartY + dy;
		applyTransform();
	}

	function endPointerDrag() {
		if (!state.dragging) return;
		state.dragging = false;
		if (state.dragPointerId != null && viewport.releasePointerCapture) {
			try {
				viewport.releasePointerCapture(state.dragPointerId);
			} catch {
				/* ignore */
			}
		}
		state.dragPointerId = null;
		viewport.classList.remove("is-panning");
	}

	function openLightbox() {
		if (state.lightbox) return;
		const lb = openMermaidLightbox(svgEl);
		state.lightbox = lb.el;
		state.lightboxClose = lb.close;
	}

	function touchDist(touches: TouchList) {
		if (!touches || touches.length < 2) return 0;
		const dx = touches[0].clientX - touches[1].clientX;
		const dy = touches[0].clientY - touches[1].clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	function onTouchStart(e: TouchEvent) {
		if (e.touches.length === 2) {
			state.pinching = true;
			state.pinchStartDist = touchDist(e.touches);
			state.pinchStartScale = state.scale;
			state.pinchStartX = state.x;
			state.pinchStartY = state.y;
			const rect = viewport.getBoundingClientRect();
			state.pinchStartCX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - (rect.left || 0);
			state.pinchStartCY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - (rect.top || 0);
			endPointerDrag();
			e.preventDefault();
		}
	}

	function onTouchMove(e: TouchEvent) {
		if (!state.pinching || e.touches.length < 2) return;
		const rect = viewport.getBoundingClientRect();
		const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - (rect.left || 0);
		const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - (rect.top || 0);
		const currDist = touchDist(e.touches);
		if (state.pinchStartDist > 0 && state.pinchStartScale > 0) {
			const rawScale = state.pinchStartScale * (currDist / state.pinchStartDist);
			const boundedScale = Math.max(minScale(), Math.min(MAX_SCALE, rawScale));
			const ratio = boundedScale / state.pinchStartScale;
			state.scale = boundedScale;
			state.x = cx - (state.pinchStartCX - state.pinchStartX) * ratio;
			state.y = cy - (state.pinchStartCY - state.pinchStartY) * ratio;
			applyTransform();
		}
		e.preventDefault();
	}

	function onTouchEnd(e: TouchEvent) {
		if (e.touches.length < 2 && state.pinching) {
			state.pinching = false;
			state.dragged = true;
		}
	}

	function openViewerOnClick(e: MouseEvent) {
		if (state.pinching) return;
		if (mode !== "inline") return;
		if (state.dragged) {
			state.dragged = false;
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		openLightbox();
	}

	viewport.onpointerdown = onPointerDown;
	viewport.onpointermove = onPointerMove;
	viewport.onpointerup = endPointerDrag;
	viewport.onpointercancel = endPointerDrag;
	viewport.onpointerleave = endPointerDrag;
	viewport.onwheel = zoomFromWheel;
	viewport.onclick = openViewerOnClick;
	viewport.addEventListener("touchstart", onTouchStart, { passive: false });
	viewport.addEventListener("touchmove", onTouchMove, { passive: false });
	viewport.addEventListener("touchend", onTouchEnd);
	viewport.addEventListener("touchcancel", () => {
		state.pinching = false;
	});
	root.onclick = e => e.stopPropagation();

	toolbar.appendChild(createButton("Zoom in", "zoomIn", zoomIn));
	toolbar.appendChild(createButton("Zoom out", "zoomOut", zoomOut));
	toolbar.appendChild(createButton("Reset view", "reset", resetViewer));
	toolbar.appendChild(createButton("Fit to screen", "fit", fitViewer));
	if (mode === "inline") toolbar.appendChild(createButton("Fullscreen", "fullscreen", openLightbox));
	if (options.source) addCopySourceButton(toolbar, options.source);

	function resizeToEnvelope() {
		if (mode !== "lightbox") return;
		const previousFitScale = state.fitScale || fitScale();
		const wasAtFit = Math.abs(state.scale - previousFitScale) < 1e-9;
		const envelope = lightboxEnvelope();
		viewport.style.width = `${Math.max(1, Math.round(envelope.width))}px`;
		viewport.style.height = `${Math.max(1, Math.round(envelope.height))}px`;
		const nextFitScale = fitScale();
		state.fitScale = nextFitScale;
		if (wasAtFit) {
			state.scale = nextFitScale;
			centerForScale(state.scale);
		} else {
			state.scale = Math.max(minScale(), Math.min(MAX_SCALE, state.scale));
		}
		applyTransform();
	}

	if (mode === "lightbox") {
		resizeToEnvelope();
		const onResize = () => {
			if (state.resizeTimer) clearTimeout(state.resizeTimer);
			state.resizeTimer = setTimeout(resizeToEnvelope, 120);
		};
		state.onResize = onResize;
		window.addEventListener("resize", onResize);
	} else {
		const initialHeight = inlineViewportHeight();
		state.scale = Math.max(minScale(), Math.min(MAX_SCALE, initialHeight / Math.max(1, box.height)));
		viewport.style.width = "100%";
		viewport.style.height = `${Math.max(1, Math.round(initialHeight))}px`;
		centerForScale(state.scale);
		applyTransform();
	}

	function destroy() {
		state.lightboxClose?.();
		state.lightbox?.remove();
		if (state.onResize) window.removeEventListener("resize", state.onResize);
		if (state.resizeTimer) clearTimeout(state.resizeTimer);
		root.remove();
	}

	return { root, destroy };
}

function openMermaidLightbox(svgEl: SVGSVGElement): LightboxHandle {
	const lb = document.createElement("div");
	lb.className = "img-lightbox";
	lb.setAttribute("role", "dialog");
	lb.setAttribute("aria-modal", "true");
	lb.setAttribute("aria-label", "Mermaid diagram");

	const clone = svgEl.cloneNode(true) as SVGSVGElement;
	const idMap = new Map<string, string>();
	const idPrefix = `mermaid-lightbox-${Math.random().toString(36).slice(2, 10)}-`;
	const idNodes = [clone, ...clone.querySelectorAll("[id]")].filter(el => el.id);
	idNodes.forEach(el => {
		const nextId = idPrefix + el.id;
		idMap.set(el.id, nextId);
		el.id = nextId;
	});
	if (idMap.size) {
		const refAttrs = [
			"href",
			"xlink:href",
			"fill",
			"stroke",
			"filter",
			"clip-path",
			"mask",
			"marker-start",
			"marker-mid",
			"marker-end",
			"aria-labelledby",
			"aria-describedby",
		];
		[clone, ...clone.querySelectorAll("*")].forEach(el => {
			refAttrs.forEach(attr => {
				const value = el.getAttribute(attr);
				if (!value) return;
				let nextValue = value.replace(/url\(#([^)]+)\)/g, (match, refId: string) =>
					idMap.has(refId) ? `url(#${idMap.get(refId)})` : match,
				);
				if (nextValue.startsWith("#") && idMap.has(nextValue.slice(1))) {
					nextValue = `#${idMap.get(nextValue.slice(1))}`;
				}
				if (nextValue !== value) el.setAttribute(attr, nextValue);
			});
		});
		clone.querySelectorAll("style").forEach(styleEl => {
			let styleText = styleEl.textContent || "";
			idMap.forEach((nextId, originalId) => {
				const escapedId = originalId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				styleText = styleText.replace(new RegExp(`url\\(#${escapedId}\\)`, "g"), `url(#${nextId})`);
				styleText = styleText.replace(
					new RegExp(`(^|[^\\w-])#${escapedId}(?=$|[^\\w-])`, "g"),
					(_match, prefix) => `${prefix}#${nextId}`,
				);
			});
			styleEl.textContent = styleText;
		});
	}
	clone.removeAttribute("width");
	clone.removeAttribute("height");
	const viewer = mountMermaidViewer(clone, { mode: "lightbox" });

	const closeBtn = document.createElement("button");
	closeBtn.className = "img-lightbox-close";
	closeBtn.setAttribute("aria-label", "Close");
	closeBtn.textContent = "×";

	const keyHandler = (e: KeyboardEvent) => {
		if (e.key === "Escape") close();
	};

	const close = () => {
		document.removeEventListener("keydown", keyHandler);
		viewer?.destroy();
		lb.remove();
	};

	closeBtn.onclick = close;
	lb.onclick = close;
	if (viewer) lb.appendChild(viewer.root);
	else lb.appendChild(clone);
	lb.appendChild(closeBtn);
	document.body.appendChild(lb);
	document.addEventListener("keydown", keyHandler);
	return { el: lb, close };
}
