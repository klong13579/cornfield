import { FolderOpen } from "lucide-react";
import { directoryPicker } from "../lib/desktop-bridge";
import type { DirectoryPicker } from "../lib/path-picker";

/**
 * 路径输入框 —— 「一个路径字符串」的唯一一种控件（Project root 与设置页工作目录共用）。
 *
 * 三件事一起说清，缺一个就会变成「打了字却没生效」那一类问题：
 *
 *   - **能打**：自由输入，前端**不做**路径校验。路径成不成立由消费它的一方判 ——
 *     Project root 必须绝对路径（serve 的 `projectInputError`），工作目录还允许 `~/`
 *     （壳的 `resolveWorkspaceDir`）。在这里再写一份判据就是第二套迟早不一致的真相。
 *   - **能选**：有桌面壳就走壳的系统原生选择器；没有壳（网页直开）就走 serve 的选择框
 *     （wire 的 `pick_directory`，由调用方经 `servePicker` 传进来 —— serve 没连上就没有）。
 *     两条通路都不可用才**不画**这个按钮 —— 网页直开时画一个点了没反应的按钮，比没有它更坏
 *     （仓库既有纪律，见 ProjectSwitcher 的刷新钮与设置页的「检查更新」）。
 *     画不画只取决于通路在不在，与输入框里有没有内容无关。
 *     浏览器自己拿不到绝对路径（`<input type="file" webkitdirectory>` 只给相对路径），所以
 *     没有壳时只能由 serve 弹 —— 那是它唯一能做对的地方。
 *   - **能少打**：`suggestions` 非空时挂 `datalist`（本机用过的路径），仍然允许自由输入。
 *     候选按给定顺序原样画，**不去重也不排序** —— 去重是产出这份清单的那一方的责任
 *     （同一个目录既可能是已声明的项目、又在用过的历史里，那个重复只对合并两边的人才看得见）。
 *     渲染层默默改掉给它的东西，就是一次看不见的输入丢弃。
 *
 * 取消选择不写回任何值：用户在系统弹窗里点「取消」是一次「什么都没发生」，不是一次空路径。
 * 选择器失败（旧壳没这个方法、IPC 抛错）交给调用方显示 —— 组件自己不留第二个错误界面，
 * 否则一次失败会在页面上出现两处说法。
 */
export interface PathFieldProps {
	/** 必填：既是 `<label htmlFor>` 的锚点，也是 datalist id 的来源（`<id>-suggestions`）。 */
	id: string;
	value: string;
	onChange: (value: string) => void;
	/** 无障碍名（`getByLabel` 的锚点）。 */
	ariaLabel: string;
	placeholder?: string;
	/** 输入框 + 按钮那一行的类名，**追加**在行布局之后（各调用点只需要补自己的外边距）。 */
	className?: string;
	/** 输入框自己的类名。 */
	inputClassName?: string;
	/** 同一行的其它控件（如「保存」），排在浏览按钮之后。 */
	trailing?: React.ReactNode;
	/** 回车时的动作（Project 声明面板用它提交）。 */
	onEnter?: () => void;
	/** 本机用过的路径候选；空 = 不挂 datalist（一个空的候选框只会碍事）。照给定顺序画，不去重。 */
	suggestions?: readonly string[];
	/** 选择器失败时的文案交回调用方显示（这里不自留一份错误状态）。 */
	onPickError: (message: string) => void;
	/**
	 * 没有桌面壳时的第二条通路：serve 的系统选择框（wire 的 `pick_directory`）。
	 * 缺省 = 这条通路现在不可用（比如 serve 还没连上）；此时如果也没有壳，就不画浏览按钮。
	 */
	servePicker?: DirectoryPicker;
}

export function PathField({
	id,
	value,
	onChange,
	ariaLabel,
	placeholder,
	className = "",
	inputClassName,
	trailing,
	onEnter,
	suggestions = [],
	servePicker,
	onPickError,
}: PathFieldProps): React.JSX.Element {
	// 每次渲染重算：壳在页面生命周期内不会消失，而这个判定本身是「window 上有没有 api」的一次查表。
	// 有壳优先走壳：壳的选择框挂在主窗口上（macOS 是 sheet，归属清楚），而且不依赖 serve 在不在
	// —— 设置页的工作目录在还没连上 serve 时也要能选。没有壳才走 serve。
	const pick = directoryPicker() ?? servePicker;
	const listId = `${id}-suggestions`;

	const browse = async (): Promise<void> => {
		if (!pick) return;
		try {
			const result = await pick(value.trim());
			if (result.canceled) return;
			if (result.path.trim() === "") {
				// 壳回了「没取消但也没路径」：这不是一次成功的选择，不能拿空串顶替。
				onPickError("桌面壳没有返回路径");
				return;
			}
			onChange(result.path);
		} catch (err) {
			onPickError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<>
			<div className={`flex items-center gap-1.5 ${className}`}>
				<input
					id={id}
					value={value}
					onChange={e => onChange(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter" && onEnter) onEnter();
					}}
					placeholder={placeholder}
					aria-label={ariaLabel}
					spellCheck={false}
					{...(suggestions.length > 0 ? { list: listId } : {})}
					className={inputClassName}
				/>
				{pick && (
					<button
						type="button"
						className="cbtn shrink-0 whitespace-nowrap"
						onClick={() => void browse()}
						title="在系统弹窗里选一个文件夹"
					>
						<FolderOpen size={13} strokeWidth={1.5} />
						浏览…
					</button>
				)}
				{trailing}
			</div>
			{suggestions.length > 0 && (
				<datalist id={listId}>
					{suggestions.map(path => (
						<option key={path} value={path} />
					))}
				</datalist>
			)}
		</>
	);
}
