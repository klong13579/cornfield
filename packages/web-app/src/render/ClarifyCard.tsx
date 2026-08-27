import { CircleHelp } from "lucide-react";
import { useState } from "react";
import "./float-card.css";

/**
 * ClarifyCard —— Agent 澄清浮层卡（R6·UI 壳）。视觉基准：v8 `.float-card`/`.fc-inner`。
 *
 * 协议形状（clarify push 到时通电）：
 *   <ClarifyCard
 *     question="需要更多信息才能继续"
 *     options={["只迁亮色", "亮色 + 深色都迁"]}
 *     onAnswer={(option) => …}
 *   />
 * 渲染位置同 ApprovalCard（父层 `position:relative` composer 容器内，卡滑入上方）。
 * 数据当前用组件默认 demo 值。
 */
export interface ClarifyCardProps {
	/** 澄清问题（默认 demo）。 */
	question?: string;
	/** 可选项（默认 demo）。 */
	options?: string[];
	/** 用户选择回调（传回所选 option 文本）。 */
	onAnswer?: (option: string) => void;
	className?: string;
}

const DEMO_QUESTION = "需要更多信息才能继续";
const DEMO_OPTIONS = ["只迁亮色（V6 现状）", "亮色 + 深色都迁", "先亮色，深色进 backlog"];

export function ClarifyCard({
	question = DEMO_QUESTION,
	options = DEMO_OPTIONS,
	onAnswer,
	className = "",
}: ClarifyCardProps): React.JSX.Element | null {
	const [hidden, setHidden] = useState(false);
	if (hidden) return null;

	const answer = (option: string) => {
		onAnswer?.(option);
		setHidden(true);
	};

	return (
		<div className={`float-card${className ? ` ${className}` : ""}`}>
			<div className="fc-inner">
				<div className="fc-header fc-header--info">
					<CircleHelp size={15} strokeWidth={1.6} />
					<span>Agent 澄清</span>
				</div>
				<div className="fc-keys fc-question">{question}</div>
				<div className="clarify-opts">
					{options.map(option => (
						<button
							key={option}
							type="button"
							className="clarify-opt hover:bg-surface-2 active:scale-[0.98]"
							onClick={() => answer(option)}
						>
							{option}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
