import type { ReactNode } from "react";

/**
 * 轻量 markdown 子集渲染（段落 / 行内 code / 加粗 / 链接 / fenced code block）。
 * 完整 markdown 渲染由 assistant-ui 转录组件接管（P3 后续接入），当前为消息展示最小可用版。
 */
export function MarkdownLite({ text, className }: { text: string; className?: string }): React.JSX.Element {
	const blocks: ReactNode[] = [];
	const chunks = text.split(/(```[\s\S]*?```)/g);

	chunks.forEach((chunk, i) => {
		if (chunk.startsWith("```")) {
			const body = chunk.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
			if (body.trim()) {
				blocks.push(
					<pre
						key={i}
						className="my-2 overflow-x-auto rounded-md border border-hairline bg-surface-2 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink"
					>
						{body.trimEnd()}
					</pre>,
				);
			}
			return;
		}
		chunk.split(/\n{2,}/).forEach(para => {
			const trimmed = para.trim();
			if (!trimmed) return;
			blocks.push(<p key={`${i}-${para.length}`}>{inlineTokens(trimmed)}</p>);
		});
	});

	return <div className={className}>{blocks}</div>;
}

function inlineTokens(text: string): ReactNode[] {
	const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
	return tokens.map((token, i) => {
		if (token.length === 0) return null;
		if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
			return (
				<code
					key={i}
					className="rounded-[4px] border border-hairline bg-surface-2 px-[5px] py-px font-mono text-[12.5px] text-ink"
				>
					{token.slice(1, -1)}
				</code>
			);
		}
		if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
			return <strong key={i}>{token.slice(2, -2)}</strong>;
		}
		const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
		if (link) {
			return (
				<a
					key={i}
					href={link[2]}
					target="_blank"
					rel="noreferrer"
					className="text-ink underline decoration-hairline-strong decoration-1 underline-offset-2 hover:text-accent-hover"
				>
					{link[1]}
				</a>
			);
		}
		return <span key={i}>{token}</span>;
	});
}
