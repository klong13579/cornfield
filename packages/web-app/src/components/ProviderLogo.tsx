/**
 * ProviderLogo —— 模型 provider 品牌 logo（模型选择器组头/当前模型按钮用）。
 *
 * 资源：`public/providers/<file>`（真实品牌 SVG/PNG，simple-icons/wikimedia 抓取）；
 * 未收录的 provider（如自研 narwal-plan）显示品牌色圆形 + 首字母徽章（fallback，不裂图）。
 */
const PROVIDER_META: Record<string, { file?: string; color: string }> = {
	"alibaba-coding-plan": { file: "alibabacloud.svg", color: "#ff6a00" },
	"bailian-coding-plan": { file: "alibabacloud.svg", color: "#ff6a00" },
	"kimi-code": { file: "kimi.svg", color: "#000000" },
	moonshot: { file: "kimi.svg", color: "#000000" },
	openai: { file: "openai.png", color: "#10a37f" },
	anthropic: { file: "anthropic.svg", color: "#d97757" },
	claude: { file: "anthropic.svg", color: "#d97757" },
	glm: { file: undefined, color: "#3859ff" },
	deepseek: { file: "deepseek.svg", color: "#4d6bfe" },
	google: { file: "googlegemini.svg", color: "#4285f4" },
	googlegemini: { file: "googlegemini.svg", color: "#4285f4" },
	minimax: { file: "minimax.svg", color: "#00b5b8" },
	qwen: { file: "qwen.svg", color: "#615ced" },
	"narwal-plan": { file: undefined, color: "#166534" },
};

function fallbackInitial(provider: string): string {
	const cleaned = provider.replace(/-(coding|plan|code)$/, "").trim();
	return (cleaned[0] ?? "?").toUpperCase();
}

/**
 * 按模型 id 前缀推断品牌（网关 provider 下一车各品牌模型，如 narwal-plan 下挂 glm/minimax/qwen/deepseek）。
 * 命中返回 PROVIDER_META 键；未命中返回 null（由调用方落 provider 组 logo）。
 */
export function brandKeyOfModel(modelId: string): string | null {
	const id = modelId.toLowerCase();
	if (id.startsWith("qwen")) return "qwen";
	if (id.startsWith("minimax")) return "minimax";
	if (id.startsWith("deepseek")) return "deepseek";
	if (id.startsWith("glm")) return "glm";
	if (id.startsWith("kimi")) return "kimi";
	if (id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) return "openai";
	if (id.startsWith("claude")) return "claude";
	if (id.startsWith("gemini")) return "googlegemini";
	return null;
}

export function ProviderLogo({
	provider,
	modelId,
	size = 14,
}: {
	provider: string;
	/** 传模型 id 时优先按品牌推断（网关多品牌模型行用）。 */
	modelId?: string;
	size?: number;
}): React.JSX.Element {
	const brand = modelId ? brandKeyOfModel(modelId) : null;
	const effective = brand ?? provider;
	const meta = PROVIDER_META[effective] ?? PROVIDER_META[provider] ?? { color: "#71717a" };
	if (meta.file) {
		return (
			<img
				src={`/providers/${meta.file}`}
				alt={`${effective} logo`}
				className="shrink-0 rounded-[3px]"
				style={{ width: size, height: size, objectFit: "contain" }}
			/>
		);
	}
	return (
		<span
			className="inline-flex shrink-0 items-center justify-center rounded-[4px] font-mono font-bold text-white"
			style={{
				width: size,
				height: size,
				background: meta.color,
				fontSize: Math.max(8, size * 0.62),
				lineHeight: 1,
			}}
		>
			{fallbackInitial(effective)}
		</span>
	);
}
