import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";
import "./markdown.css";

import type { Element, ElementContent, Text } from "hast";

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { MarkdownImage } from "./MarkdownImage";
import { Mermaid } from "./Mermaid";

// hermes SAFE_TAGS（HTML 白名单）—— 只放行这些标签，其余剥离（R-HTML 卡）。
const SAFE_TAGS = [
	"strong",
	"em",
	"del",
	"code",
	"pre",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
	"li",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	"hr",
	"blockquote",
	"p",
	"br",
	"a",
	"div",
	"span",
	"img",
	// GFM 任务列表 checkbox（remark-gfm 产物，非 raw HTML；剥离会破坏已有任务列表）
	"input",
];

const sanitizeSchema = {
	...defaultSchema,
	tagNames: SAFE_TAGS,
	protocols: {
		...(defaultSchema.protocols ?? {}),
		// img 允许 data:image/*（base64 内联图）；a href 只允许 http/https/mailto
		src: ["http", "https", "data"],
		href: ["http", "https", "mailto"],
	},
};

/**
 * markdown 渲染器重实现（R1b）—— 只被 `Markdown.tsx`（lazy 包装）动态 import。
 *
 * 管线：remark-gfm（表格/删除线/任务列表/自动链接）→ remark-math（$…$/$$…$$）
 * → rehype-raw（raw HTML 解析）→ rehype-sanitize（SAFE_TAGS 白名单）
 * → rehype-katex（数学公式）→ rehype-highlight（代码高亮）。
 * react-markdown 构建 React 元素而非 innerHTML；raw HTML 经 sanitize 白名单过滤，XSS 安全。
 *
 * 本模块携带 katex/highlight.css 与两家全量依赖，必须保持动态加载不进主包；
 * 样式收敛在 `markdown.css` 的 `.md` 命名空间，用 V6 亮色 token 变量。
 */
function extractMermaidCode(node: Element | undefined): string | null {
	if (!node) return null;
	const codeNode = node.children.find(
		(child: ElementContent): child is Element => child.type === "element" && child.tagName === "code",
	);
	if (!codeNode) return null;
	const cls = codeNode.properties?.className ?? [];
	if (!cls.includes("language-mermaid")) return null;
	return codeNode.children
		.filter((child: ElementContent): child is Text => child.type === "text")
		.map(child => child.value)
		.join("")
		.trimEnd();
}

export function MarkdownRenderer({ text, className = "" }: { text: string; className?: string }): React.JSX.Element {
	return (
		<div className={`md ${className}`}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm, remarkMath]}
				rehypePlugins={[
					rehypeRaw,
					[rehypeSanitize, sanitizeSchema],
					rehypeKatex,
					[rehypeHighlight, { detect: false, ignoreMissing: true }],
				]}
				components={{
					a({ href, children }: { href?: string; children?: React.ReactNode }) {
						return (
							<a href={href} target="_blank" rel="noreferrer">
								{children}
							</a>
						);
					},
					img({ src, alt }: { src?: string; alt?: string }) {
						return <MarkdownImage src={src} alt={alt} />;
					},
					pre({ node, children }: { node?: Element; children?: React.ReactNode }) {
						const mermaidCode = extractMermaidCode(node);
						if (mermaidCode !== null) return <Mermaid code={mermaidCode} />;
						return <pre>{children}</pre>;
					},
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}
