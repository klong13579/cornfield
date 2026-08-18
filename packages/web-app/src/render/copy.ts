/**
 * 剪贴板写入（R4 / P2-W2-2 共用）—— navigator.clipboard.writeText 优先，
 * 失败回退 document.execCommand("copy")（非安全上下文 / 旧 WebView 兜底）。
 * MsgActions 的 copy 与 mermaid 查看器的『复制源码』共用这一实现。
 */
export async function copyText(text: string): Promise<boolean> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			/* fall through to execCommand */
		}
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}
