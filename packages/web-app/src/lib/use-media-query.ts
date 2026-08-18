import { useEffect, useState } from "react";

/** 轻量媒体查询 hook（matchMedia + 订阅）。用于移动端/桌面端行为切换。 */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

	useEffect(() => {
		const mql = window.matchMedia(query);
		const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
		setMatches(mql.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [query]);

	return matches;
}

/** 移动端（<lg，1024px 以下）：右栏/工具卡/快捷条切换到移动形态。 */
export function useIsMobile(): boolean {
	return useMediaQuery("(max-width: 1023px)");
}
