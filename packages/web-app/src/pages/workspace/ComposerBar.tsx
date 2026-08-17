import { ChevronDown, Cpu, Mic, Paperclip, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSessionStore } from "../../state/session-store";
import { getUiStore, useUiState } from "../../state/ui-store";
import { useSession } from "../../state/use-session";

const MODEL_MENU = [
	{ id: "claude-opus-4-5", provider: "anthropic" },
	{ id: "claude-sonnet-4-5", provider: "anthropic" },
	{ id: "qwen3.7-max", provider: "narwal-plan" },
	{ id: "minimax-m3", provider: "narwal-plan" },
	{ id: "gemini-2.5-pro", provider: "google" },
];

const THINKING_LEVELS = ["off", "low", "medium", "high"];

/**
 * 工作台输入区（assistant-ui Composer 就绪前的原生实现，两行：textarea + 工具栏）。
 * - Enter 发送 / Shift+Enter 换行 / Esc 中止（streaming 时）；发送↔停止原位替换
 * - 草稿自动保留（localStorage）
 * - 工具栏：Agent 选择器（按工作区分组 + CODING/WORKER + 钉钉角标）、附件、语音、
 *   模型/thinking 下拉、发送/停止
 */
export function ComposerBar({ autoFocusDraft = "" }: { autoFocusDraft?: string }): React.JSX.Element {
	const view = useSession();
	const store = useSessionStore();
	const ui = useUiState();
	const navigate = useNavigate();
	const textRef = useRef<HTMLTextAreaElement>(null);
	const [agentId, setAgentId] = useState(view.agents[0]?.id ?? "dev-assistant");
	const [showAgentMenu, setShowAgentMenu] = useState(false);
	const [showModelMenu, setShowModelMenu] = useState(false);
	const value = ui.draft || autoFocusDraft;

	const active = view.isStreaming || view.phase !== "idle";
	const agent = view.agents.find(a => a.id === agentId) ?? view.agents[0];

	useEffect(() => {
		if (autoFocusDraft) textRef.current?.focus();
	}, [autoFocusDraft]);

	const autoGrow = () => {
		const el = textRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
	};

	const send = () => {
		const text = value.trim();
		if (!text) return;
		getUiStore().setDraft("");
		store.prompt(text);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (active) {
				store.abort();
			} else {
				send();
			}
		} else if (e.key === "Escape" && active) {
			store.abort();
		}
	};

	return (
		<div className="shrink-0 border-t border-hairline bg-surface px-4.5 pt-3.5 pb-3">
			<div className="relative mx-auto max-w-[800px]">
				<div className="rounded-xl border border-hairline bg-surface-2 transition-[border-color,box-shadow] duration-150 focus-within:border-hairline-strong focus-within:shadow-[0_0_0_3px_var(--color-accent-dim)]">
					<textarea
						ref={textRef}
						rows={1}
						value={value}
						placeholder={`@${agent?.name ?? "Agent"} 发消息，或直接提问…`}
						onChange={e => getUiStore().setDraft(e.target.value)}
						onInput={autoGrow}
						onKeyDown={onKeyDown}
						className="min-h-[52px] w-full resize-none border-none bg-transparent px-3.5 pt-3 pb-1.5 font-inherit text-ink outline-none placeholder:text-ink-faint"
					/>
					<div className="flex items-center gap-2 overflow-x-auto px-2.5 pb-1.5">
						{/* Agent 选择器 */}
						<div className="relative">
							<button
								type="button"
								className="flex items-center gap-2 rounded-md border border-hairline bg-surface-3 py-1 pr-2 pl-1 text-[12px] transition-colors hover:border-hairline-strong"
								onClick={() => setShowAgentMenu(v => !v)}
							>
								<span className="relative flex h-6 w-6 items-center justify-center rounded-[6px] border border-hairline bg-surface-2 text-[10px] font-semibold text-ink">
									{agent?.face ?? "?"}
									{agent?.dingtalkBound && (
										<span
											className="absolute -right-1 -bottom-1 flex h-3 w-3 items-center justify-center rounded-[4px] bg-dingtalk"
											title="钉钉绑定"
										/>
									)}
								</span>
								<span className="font-medium text-ink">@{agent?.name ?? "Agent"}</span>
								<ChevronDown size={11} strokeWidth={1.5} className="text-ink-faint" />
							</button>
							{showAgentMenu && (
								<div className="absolute bottom-[calc(100%+8px)] left-0 z-30 min-w-65 overflow-hidden rounded-md border border-hairline-strong bg-surface shadow-lg">
									{["研发工作区", "运营工作区"].map(ws => (
										<div key={ws}>
											<div className="border-b border-hairline px-3 py-2 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
												{ws}
											</div>
											{view.agents
												.filter(a => a.workspace === ws)
												.map(a => (
													<button
														key={a.id}
														type="button"
														className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-3 ${a.id === agentId ? "bg-accent-dim" : ""}`}
														onClick={() => {
															setAgentId(a.id);
															setShowAgentMenu(false);
														}}
													>
														<span className="flex h-5 w-5 items-center justify-center rounded bg-surface-2 text-[9px] font-semibold">
															{a.face}
														</span>
														<span className="text-ink">@{a.name}</span>
														<span className="ml-auto text-[10px] text-ink-faint">
															{a.kind === "coding" ? "CODING" : "WORKER"}
														</span>
													</button>
												))}
										</div>
									))}
								</div>
							)}
						</div>

						<span className="h-[18px] w-px bg-hairline" />
						<button type="button" className="cbtn shrink-0" title="上传附件（P3 接入）" aria-disabled>
							<Paperclip size={15} strokeWidth={1.5} />
							<span className="hidden sm:inline">附件</span>
						</button>
						<button type="button" className="cbtn" title="语音输入" onClick={() => navigate("/voice")}>
							<Mic size={15} strokeWidth={1.5} />
						</button>

						<div className="flex-1" />

						{/* 模型 + thinking 下拉 */}
						<div className="relative">
							<button type="button" className="cbtn" onClick={() => setShowModelMenu(v => !v)}>
								<Cpu size={15} strokeWidth={1.5} />
								<b className="font-mono text-[12px] font-medium text-ink">{view.model ?? "—"}</b>
								<span className="rounded-[4px] bg-surface-3 px-1.5 py-px font-mono text-[10px] text-ink-subtle">
									{view.thinkingLevel ?? "off"}
								</span>
								<ChevronDown size={11} strokeWidth={1.5} className="text-ink-faint" />
							</button>
							{showModelMenu && (
								<div className="absolute right-0 bottom-[calc(100%+8px)] z-30 min-w-60 overflow-hidden rounded-md border border-hairline-strong bg-surface p-1 shadow-lg">
									<div className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
										模型
									</div>
									{MODEL_MENU.map(m => (
										<button
											key={m.id}
											type="button"
											className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left font-mono text-[13px] transition-colors hover:bg-surface-3 ${m.id === view.model ? "bg-accent-dim" : ""}`}
											onClick={() => {
												store.setModel(m.id, m.provider);
												setShowModelMenu(false);
											}}
										>
											{m.id}
											<span className="ml-auto font-sans text-[10px] text-ink-faint">{m.provider}</span>
										</button>
									))}
									<div className="mt-1.5 px-2.5 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
										思维级别
									</div>
									{THINKING_LEVELS.map(level => (
										<button
											key={level}
											type="button"
											className={`flex w-full items-center rounded px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-3 ${level === view.thinkingLevel ? "bg-accent-dim" : ""}`}
											onClick={() => {
												store.setThinkingLevel(level);
												setShowModelMenu(false);
											}}
										>
											{level}
										</button>
									))}
								</div>
							)}
						</div>

						<span className="h-[18px] w-px bg-hairline" />

						{/* 发送 ↔ 停止 原位替换 */}
						<button
							type="button"
							onClick={() => (active ? store.abort() : send())}
							className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-none transition-colors ${active ? "bg-danger text-white hover:bg-danger/85" : "bg-accent text-on-accent hover:bg-accent-hover"}`}
							aria-label={active ? "停止" : "发送"}
						>
							{active ? (
								<Square size={14} strokeWidth={1.5} fill="currentColor" />
							) : (
								<Send size={14} strokeWidth={1.5} />
							)}
						</button>
					</div>
				</div>
				<div className="mt-1.5 flex gap-3.5 text-[11px] text-ink-faint">
					<span>
						<span className="kbd">Enter</span> 发送 · <span className="kbd">Shift+Enter</span> 换行 ·{" "}
						<span className="kbd">Esc</span> 中止
					</span>
					<span>draft 自动保留 · 输入自适应增高</span>
				</div>
			</div>
		</div>
	);
}
