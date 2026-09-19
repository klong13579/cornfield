import { useEffect, useRef, useState } from "react";
import {
	createDragSession,
	type DividerAxis,
	type DividerTarget,
	type DragSession,
	KEY_STEP_COARSE_PX,
	KEY_STEP_PX,
	type PaneEdge,
	stepDivider,
} from "../lib/pane-resize";

/**
 * 分栏分隔条：指针拖动 + 键盘 ←→/↑↓（Shift 粗调）+ 双击复位。
 *
 * 这里只做三件事：把事件换成坐标、拖拽期间给 body 挂类、把结果交给 `target`。几何与越界全在
 * `lib/pane-resize.ts`（`createDragSession` / `stepDivider`）—— 渲染测试只能直渲 SSR，指针事件
 * 在那里碰不到，所以有分支的部分必须住在能被普通单测碰到的地方。
 *
 * 拖拽中**不经过 React**：每帧只改容器上一个 CSS 变量（`target.preview`）。这不是性能洁癖 ——
 * 工作台在流式输出时每次会话更新都会重渲染，如果拖拽中的宽度靠 React state 承载，一次无关的
 * 重渲染就会把宽度弹回偏好值。落盘只发生在松手，那时 React 把同一个值写回同一个变量：值相等，
 * 也就没有跳变。
 */
export function PaneDivider({
	axis,
	edge,
	target,
	className = "",
}: {
	axis: DividerAxis;
	edge: PaneEdge;
	target: DividerTarget;
	/** 断点可见性之类的附加类（移动端的分栏是抽屉，没有可拖的分隔条）。 */
	className?: string;
}): React.JSX.Element {
	const [dragging, setDragging] = useState(false);
	// 每次按下新建一个现场：它记住的是这一拖的起点，既不跨次复用，也不怕重渲染把它换掉。
	const drag = useRef<DragSession | null>(null);

	// 拖拽中给 body 挂类：指针甩到细条外仍是 resize 光标、不会顺手选中旁边的文本，
	// 被拖那一栏的宽度过渡也在这段时间里关掉（过渡会让分隔条追不上指针）。
	useEffect(() => {
		if (!dragging) return;
		const cls = axis === "vertical" ? "pane-resizing-col" : "pane-resizing-row";
		document.body.classList.add("pane-resizing", cls);
		return () => document.body.classList.remove("pane-resizing", cls);
	}, [dragging, axis]);

	const coordinateOf = (e: { clientX: number; clientY: number }): number =>
		axis === "vertical" ? e.clientX : e.clientY;

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
		if (e.button !== 0) return;
		e.currentTarget.setPointerCapture(e.pointerId);
		const session = createDragSession({ target, edge });
		session.begin(coordinateOf(e));
		drag.current = session;
		setDragging(true);
		e.preventDefault();
	};

	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
		// 没有捕获到的指针移动（没按下）不该改任何东西：现场不在就不动。
		drag.current?.move(coordinateOf(e));
	};

	// 三个收尾事件共用一条路：抬起 / 取消 / 丢失捕获都只该结束一次（现场清掉后重复进来直接返回）。
	const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
		const session = drag.current;
		if (session === null) return;
		drag.current = null;
		setDragging(false);
		if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
		session.end();
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
		const direction =
			axis === "vertical"
				? e.key === "ArrowRight"
					? 1
					: e.key === "ArrowLeft"
						? -1
						: 0
				: e.key === "ArrowDown"
					? 1
					: e.key === "ArrowUp"
						? -1
						: 0;
		if (direction === 0) return;
		e.preventDefault();
		stepDivider(target, edge, direction, e.shiftKey ? KEY_STEP_COARSE_PX : KEY_STEP_PX);
	};

	const a11y = target.a11y();

	return (
		// biome-ignore lint/a11y/useSemanticElements: 可聚焦的 window splitter 就该是 div + role=separator（WAI-ARIA APG）；<hr> 是静态主题分隔，不是控件
		<div
			role="separator"
			aria-orientation={axis}
			aria-label={target.label}
			aria-valuenow={Math.round(a11y.now)}
			aria-valuemin={Math.round(a11y.min)}
			aria-valuemax={Math.round(a11y.max)}
			aria-valuetext={a11y.text}
			tabIndex={0}
			data-dragging={dragging ? "true" : undefined}
			className={["pane-divider", axis === "horizontal" ? "pane-divider--row" : null, className]
				.filter((name): name is string => name !== null && name !== "")
				.join(" ")}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			onLostPointerCapture={endDrag}
			onKeyDown={onKeyDown}
			onDoubleClick={() => target.reset()}
		/>
	);
}
