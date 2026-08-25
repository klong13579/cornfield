import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { useEffect, useState } from "react";
import { getWireClient } from "../wire/client";

/** config.yml 里模型默认角色 key（provider/modelId 字符串）。 */
const MODEL_KEY = "modelRoles.default";
/** config.yml 里默认 thinking level key。 */
const THINKING_KEY = "defaultThinkingLevel";

/** thinking 选项（Effort 是 const enum，跨模块不能作值访问 —— 用字面量，cast 回 ThinkingLevel）。 */
const THINKING_OPTIONS: string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** 拆 "provider/modelId" → { provider, modelId }（modelId 可含后续 /）。 */
function splitModelKey(key: string): { provider: string; modelId: string } {
	const idx = key.indexOf("/");
	if (idx < 0) return { provider: key, modelId: "" };
	return { provider: key.slice(0, idx), modelId: key.slice(idx + 1) };
}

const baseStyle: React.CSSProperties = {
	padding: "12px",
	fontSize: "12px",
	lineHeight: 1.6,
	color: "var(--editor-foreground, #333)",
};

const fieldStyle: React.CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: "4px",
	marginBottom: "12px",
};

const inputStyle: React.CSSProperties = {
	width: "100%",
	boxSizing: "border-box",
	padding: "4px 6px",
	fontSize: "12px",
	border: "1px solid var(--editorWidget-border, #ccc)",
	borderRadius: "2px",
};

const buttonStyle: React.CSSProperties = {
	alignSelf: "flex-start",
	padding: "4px 10px",
	fontSize: "12px",
	cursor: "pointer",
	border: "1px solid var(--button-border, #aaa)",
	borderRadius: "2px",
	background: "var(--button-background, #f4f4f4)",
};

/**
 * ConfigView —— 设置面板（票 07）。
 *
 * 读/写 omp config.yml（modelRoles.default / defaultThinkingLevel）经 wire
 * get_config/set_config；应用时同时走 set_model / set_thinking_level 让当前
 * agent 会话立即生效。OpenSumi 偏好（布局/面板开关等瞬时态）已由 render-app
 * 的 preferenceDirName 重定向，不落 ~/.sumi。
 */
export function ConfigView(): React.JSX.Element {
	const wire = getWireClient();
	const [modelKey, setModelKey] = useState("");
	const [thinking, setThinking] = useState("high");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount 时加载一次（wire 为单例）
	useEffect(() => {
		wire.ensureConnected();
		let cancelled = false;
		void (async () => {
			try {
				const [modelCfg, thinkingCfg] = await Promise.all([
					wire.getConfig(MODEL_KEY),
					wire.getConfig(THINKING_KEY),
				]);
				if (cancelled) return;
				setModelKey(typeof modelCfg.config === "string" ? modelCfg.config : "");
				setThinking(typeof thinkingCfg.config === "string" ? thinkingCfg.config : "high");
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const apply = async () => {
		setError(null);
		setSaved(null);
		try {
			await wire.setConfig(MODEL_KEY, modelKey);
			const { provider, modelId } = splitModelKey(modelKey);
			if (modelId) await wire.setModel(provider, modelId);
			await wire.setConfig(THINKING_KEY, thinking);
			await wire.setThinkingLevel(thinking as ThinkingLevel);
			setSaved("已写入 omp config.yml 并即时生效");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<div style={baseStyle}>
			<div style={{ marginBottom: "8px", fontWeight: 600 }}>omp 设置</div>
			{loading ? (
				<div>加载中…</div>
			) : (
				<>
					<div style={fieldStyle}>
						<label htmlFor="omp-model-key">默认模型（provider/modelId）</label>
						<input
							id="omp-model-key"
							style={inputStyle}
							value={modelKey}
							onChange={e => setModelKey(e.target.value)}
							placeholder="narwal-plan/deepseek-v4-flash"
						/>
					</div>
					<div style={fieldStyle}>
						<label htmlFor="omp-thinking-level">默认 thinking</label>
						<select
							id="omp-thinking-level"
							style={inputStyle}
							value={thinking}
							onChange={e => setThinking(e.target.value)}
						>
							{THINKING_OPTIONS.map(o => (
								<option key={o} value={o}>
									{o}
								</option>
							))}
						</select>
					</div>
					<button type="button" style={buttonStyle} onClick={apply}>
						应用
					</button>
					{error ? <div style={{ marginTop: "8px", color: "var(--errorForeground, #c00)" }}>{error}</div> : null}
					{saved ? <div style={{ marginTop: "8px" }}>{saved}</div> : null}
				</>
			)}
		</div>
	);
}
