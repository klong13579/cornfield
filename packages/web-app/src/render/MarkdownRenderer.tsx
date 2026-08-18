import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";
import "./markdown.css";

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

/**
 * markdown 渲染器重实现（R1b）—— 只被 `Markdown.tsx`（lazy 包装）动态 import。
 *
 * 与 R1a spike 相同的管线：remark-gfm（表格/删除线/任务列表/自动链接）
 * → remark-math（$…$/$$…$$） → rehype-katex（数学公式）
 * → rehype-highlight（代码高亮，highlight.js）。
 * react-markdown 构建 React 元素而非 innerHTML，XSS 安全，无需 DOMPurify。
 *
 * 本模块携带 katex/highlight.css 与两家全量依赖，必须保持动态加载不进主包；
 * 样式收敛在 `markdown.css` 的 `.md` 命名空间，用 V6 亮色 token 变量。
 */
export function MarkdownRenderer({ text, className = "" }: { text: string; className?: string }): React.JSX.Element {
	return (
		<div className={`md ${className}`}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm, remarkMath]}
				rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
				components={{
					a({ href, children }) {
						return (
							<a href={href} target="_blank" rel="noreferrer">
								{children}
							</a>
						);
					},
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}
