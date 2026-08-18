import { lazy, Suspense } from "react";

/**
 * 助手消息 markdown 渲染入口（R1b）—— Transcript/ThinkingFold 从这 import。
 *
 * 采用 React.lazy 动态加载 `MarkdownRenderer`，把 react-markdown + remark/rehype
 * + katex + highlight.js 全量依赖从主包切出（R1b 验收：主包增量 < 50KB gzip）。
 * 首次出现 markdown 消息时按需拉取并缓存；加载前用纯文本 fallback 顶住流式输出。
 */
const MarkdownRenderer = lazy(() => import("./MarkdownRenderer").then(m => ({ default: m.MarkdownRenderer })));

export function Markdown({ text, className = "" }: { text: string; className?: string }): React.JSX.Element {
	return (
		<Suspense fallback={<div className={`whitespace-pre-wrap break-words ${className}`}>{text}</div>}>
			<MarkdownRenderer text={text} className={className} />
		</Suspense>
	);
}
