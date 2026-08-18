import { lazy, Suspense } from "react";

/**
 * mermaid 图渲染入口（R2）—— MarkdownRenderer 从这 import。
 *
 * 采用 React.lazy 动态加载 `MermaidRenderer`，把 mermaid 全量依赖切出
 * markdown chunk 之外（只在消息里真出现 mermaid 块时才拉取）。
 * 加载前用源码 code 块 fallback 顶住。
 */
const MermaidRenderer = lazy(() => import("./MermaidRenderer").then(m => ({ default: m.MermaidRenderer })));

export function Mermaid({ code }: { code: string }): React.JSX.Element {
	return (
		<Suspense
			fallback={
				<pre className="overflow-x-auto rounded-md border border-hairline bg-surface-2 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
					{code.trimEnd()}
				</pre>
			}
		>
			<MermaidRenderer code={code} />
		</Suspense>
	);
}
