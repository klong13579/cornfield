import type { DomainDto } from "@oh-my-pi/pi-wire";
import { useEffect, useState } from "react";
import { getWireClient } from "../wire/client";

const panelStyle: React.CSSProperties = {
	padding: "12px",
	fontSize: "12px",
	lineHeight: 1.6,
	color: "var(--editor-foreground, #333)",
};

const domainCardStyle: React.CSSProperties = {
	border: "1px solid var(--editorWidget-border, #ddd)",
	borderRadius: "6px",
	padding: "10px",
	marginBottom: "10px",
	background: "var(--editorWidget-background, #fbfbfb)",
};

const agentRowStyle: React.CSSProperties = {
	display: "flex",
	justifyContent: "space-between",
	alignItems: "center",
	padding: "3px 0",
	borderBottom: "1px solid var(--editorWidget-border, #eee)",
};

const leadBadgeStyle: React.CSSProperties = {
	fontSize: "10px",
	padding: "1px 6px",
	borderRadius: "8px",
	background: "var(--badge-background, #1a73e8)",
	color: "#fff",
	marginLeft: "6px",
};

/**
 * DomainView —— 域管理视图（B1，D8/D10）。
 *
 * 展示域列表（域 = agent 的 domain 声明聚合）：域名、域 agent（lead）、域内 agent 明细。
 * 数据来自 wire list_domains；域声明在 agent 注册（registry.json domain 字段）。
 */
export function DomainView(): React.JSX.Element {
	const wire = getWireClient();
	const [domains, setDomains] = useState<DomainDto[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount 时加载一次（wire 为单例）
	useEffect(() => {
		wire.ensureConnected();
		let cancelled = false;
		void (async () => {
			try {
				const res = await wire.listDomains();
				if (!cancelled) setDomains(res.domains);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	if (error) {
		return (
			<div style={panelStyle}>
				<div style={{ fontWeight: 600, marginBottom: "8px" }}>域管理</div>
				<div style={{ color: "var(--errorForeground, #c00)" }}>{error}</div>
			</div>
		);
	}

	if (!domains) {
		return (
			<div style={panelStyle}>
				<div style={{ fontWeight: 600, marginBottom: "8px" }}>域管理</div>
				<div style={{ opacity: 0.7 }}>加载中…</div>
			</div>
		);
	}

	return (
		<div style={panelStyle}>
			<div style={{ fontWeight: 600, marginBottom: "8px" }}>域管理</div>
			{domains.length === 0 ? (
				<div style={{ opacity: 0.7 }}>
					暂无域。域声明 = agent 注册（registry.json）条目的 domain 字段；域 agent 标记 lead。
				</div>
			) : (
				domains.map(domain => (
					<div key={domain.id} style={domainCardStyle}>
						<div style={{ fontWeight: 600, marginBottom: "4px" }}>
							{domain.name}
							{domain.leadAgentId ? <span style={leadBadgeStyle}>域 agent</span> : null}
						</div>
						<div style={{ opacity: 0.75, marginBottom: "6px" }}>
							{domain.agents.length} 个 agent
							{domain.leadAgentId ? ` · 大脑：${domain.leadAgentId}` : ""}
						</div>
						{domain.agents.map(agent => (
							<div key={agent.id} style={agentRowStyle}>
								<span>
									{agent.name}
									{agent.id === domain.leadAgentId ? <span style={leadBadgeStyle}>lead</span> : null}
								</span>
								<span style={{ opacity: 0.65 }}>
									{agent.skillsCount !== undefined ? `${agent.skillsCount} 技能` : ""}
									{agent.phase ? ` · ${agent.phase}` : ""}
								</span>
							</div>
						))}
					</div>
				))
			)}
		</div>
	);
}
