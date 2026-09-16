import { Link, useLocation } from "react-router-dom";

/**
 * 壳里的兜底页 —— 没人认领的路径（打错的深链、过期的书签）落在这里。
 *
 * 它是**一条真路由**（router.tsx 的 `path: "*"`），不是 React Router 的默认错误页：
 * 默认那一页是给开发者看的，连侧栏都没有，用户会原地卡住。长在外壳里才能自己走掉。
 */
export function NotFoundView(): React.JSX.Element {
	const { pathname } = useLocation();

	return (
		<div className="flex h-full items-center justify-center">
			<div className="text-center">
				<div className="text-[13px] text-ink-subtle">未找到这个位置</div>
				<div className="mt-1 font-mono text-[12px] text-ink-faint">{pathname}</div>
				<Link to="/" className="link mt-4 inline-block">
					回到 Home
				</Link>
			</div>
		</div>
	);
}
