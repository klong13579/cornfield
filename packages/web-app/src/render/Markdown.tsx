import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";
import "./markdown.css";

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

/**
 * 助手消息 markdown 渲染器（R1a/R1b —— 替换 MarkdownLite）。
 *
 * 管线：remark-gfm（表格/删除线/任务列表/自动链接） → remark-math（$…$/$$…$$）
 *     → rehype-katex（数学公式） → rehype-highlight（代码高亮，highlight.js）。
 * react-markdown 构建 React 元素而非 innerHTML，XSS 安全，无需 DOMPurify。
 *
 * 样式全部收敛在 `markdown.css` 的 `.md` 命名空间，用 V6 亮色 token 变量，
 * 不引 Tailwind utility（避免与 preflight/highlight.js 的 global 样式打架）。
 */
export function Markdown({ text, className = "" }: { text: string; className?: string }): React.JSX.Element {
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
