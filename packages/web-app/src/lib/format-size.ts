/**
 * 字节数显示（产物面板 / 文件树 / 输入区附件三处共用）。
 *
 * 之前产物面板与文件树各有一份逐字相同的 `fmtSize`；输入区再加一份就是第三份。
 * 三处说的是同一件事（这个文件多大），所以只有一份实现。
 *
 * 输出刻意保持原样（`8K` / `1.2M`，单位不带 B）：这不是重命名，是收口，
 * 改文案会顺带动到两个不相关的页面。
 */
export function fmtSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}K`;
	return String(bytes);
}
