import mermaid from "mermaid";
import { useEffect, useRef, useState } from "react";
import "./mermaid.css";
import { mountMermaidViewer, type ViewerHandle } from "./mermaid-viewer";

/**
 * mermaid 重渲染器（R2）—— 只被 `Mermaid.tsx`（lazy 包装）动态 import。
 * 携带 mermaid 全量依赖，必须保持动态加载不进 markdown/主包。
 *
 * 视觉：主题跟随 V6 亮色 token（`resolveTheme`），lightbox/缩放/平移
 * 查看器由 `mermaid-viewer.ts` 的 `mountMermaidViewer` 挂载。
 */
export interface MermaidRendererProps {
	code: string;
}

let initialized = false;

function resolveTheme(): Record<string, unknown> {
	const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
	if (dark) {
		return {
			theme: "dark",
			themeVariables: {
				background: "#09090b",
				primaryColor: "#18181b",
				primaryTextColor: "#fafafa",
				primaryBorderColor: "rgba(255,255,255,0.16)",
				lineColor: "rgba(250,250,250,0.44)",
				secondaryColor: "#232327",
				tertiaryColor: "#101013",
				clusterBkg: "#101013",
				clusterBorder: "rgba(255,255,255,0.08)",
				fontSize: "14px",
			},
		};
	}
	return {
		theme: "base",
		themeVariables: {
			background: "#ffffff",
			primaryColor: "#f0f0f2",
			primaryTextColor: "#18181b",
			primaryBorderColor: "rgba(24,24,27,0.18)",
			lineColor: "rgba(24,24,27,0.5)",
			secondaryColor: "#e6e6e9",
			tertiaryColor: "#f7f7f8",
			clusterBkg: "#f7f7f8",
			clusterBorder: "rgba(24,24,27,0.09)",
			fontSize: "14px",
		},
	};
}

function ensureInit(): void {
	if (initialized) return;
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: "strict",
		fontFamily: "inherit",
		...resolveTheme(),
		flowchart: { useMaxWidth: false },
		sequence: { useMaxWidth: false },
	});
	initialized = true;
}

export function MermaidRenderer({ code }: MermaidRendererProps): React.JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		let viewer: ViewerHandle | null = null;
		const id = `m-${Math.random().toString(36).slice(2)}`;

		(async () => {
			try {
				ensureInit();
				const { svg } = await mermaid.render(id, code);
				document.getElementById(`d${id}`)?.remove();
				if (cancelled) return;
				const el = containerRef.current;
				if (el) {
					el.innerHTML = svg;
					const svgEl = el.querySelector("svg");
					if (svgEl) viewer = mountMermaidViewer(svgEl, { mode: "inline" });
				}
				setError(null);
			} catch (err) {
				document.getElementById(`d${id}`)?.remove();
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();

		return () => {
			cancelled = true;
			viewer?.destroy();
			document.getElementById(`d${id}`)?.remove();
			if (containerRef.current) containerRef.current.innerHTML = "";
		};
	}, [code]);

	if (error) {
		return (
			<div className="mermaid-error" title={error}>
				{`mermaid 渲染失败：${error}\n\n${code}`}
			</div>
		);
	}

	return <div ref={containerRef} className="mermaid-diagram" />;
}
