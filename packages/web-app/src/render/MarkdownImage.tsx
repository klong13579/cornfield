import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./lightbox.css";

/** 图片点击放大浮层（复用 mermaid lightbox 的 `.img-lightbox` 浮层模式，R-IMG）。 */
function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }): React.JSX.Element {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	return createPortal(
		<div
			className="img-lightbox"
			role="dialog"
			aria-modal="true"
			aria-label={alt ?? "图片预览"}
			onClick={e => {
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={e => {
				if (e.key === "Escape") onClose();
			}}
		>
			<img src={src} alt={alt} className="img-lightbox-media" />
			<button type="button" className="img-lightbox-close" aria-label="关闭图片预览" onClick={onClose}>
				×
			</button>
		</div>,
		document.body,
	);
}

/** Markdown 图片：真实渲染 + 懒加载 + 点击放大（R-IMG；sanitize 已保证 src 安全）。 */
export function MarkdownImage({ src, alt }: { src?: string; alt?: string }): React.JSX.Element | null {
	const [open, setOpen] = useState(false);
	if (!src) return null;
	return (
		<>
			<button
				type="button"
				className="markdown-img-btn"
				aria-label={alt ? `查看图片：${alt}` : "查看图片"}
				onClick={() => setOpen(true)}
			>
				<img src={src} alt={alt} loading="lazy" className="markdown-img" />
			</button>
			{open && <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
		</>
	);
}
