import type { DomainDto, DomainReportResult } from "@oh-my-pi/pi-wire";
import { useEffect, useState } from "react";
import { getWireClient } from "../wire/client";

const panelStyle: React.CSSProperties = {
	padding: "12px",
	fontSize: "12px",
	lineHeight: 1.6,
	color: "var(--editor-foreground, #333)",
};

const reportCardStyle: React.CSSProperties = {
	border: "1px solid var(--editorWidget-border, #ddd)",
	borderRadius: "6px",
	padding: "10px",
	marginBottom: "10px",
	background: "var(--editorWidget-background, #fbfbfb)",
};

const reportTextStyle: React.CSSProperties = {
	fontSize: "11px",
	whiteSpace: "pre-wrap",
	wordBreak: "break-all",
	background: "var(--editor-background, #fff)",
	borderRadius: "3px",
	padding: "6px 8px",
	marginTop: "6px",
	maxHeight: "180px",
	overflow: "auto",
};

const agentChipStyle: React.CSSProperties = {
	display: "inline-block",
	padding: "1px 8px",
	margin: "2px 4px 2px 0",
	borderRadius: "8px",
	border: "1px solid var(--editorWidget-border, #ddd)",
	fontSize: "11px",
};

const expandStyle: React.CSSProperties = { cursor: "pointer", userSelect: "none" };

/**
 * CeoWorkbenchView —— CEO 工作台第一屏（B2，D11）。
 *
 * 分层下钻：域级战报（每域一张卡：战报 = 域 agent 的 context/summary.md 产出）+
 * 跨域事项区（待域 agent 上报，MVP 占位）+ 点卡下钻到域内员工 agent 明细。
 * 数据：wire list_domains + 每域 domain_report。
 */
export function CeoWorkbenchView(): React.JSX.Element {
	const wire = getWireClient();
	const [domains, setDomains] = useState<DomainDto[] | null>(null);
	const [reports, setReports] = useState<Record<string, DomainReportResult>>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount 时加载一次（wire 为单例）
	useEffect(() => {
		wire.ensureConnected();
		let cancelled = false;
		void (async () => {
			try {
				const res = await wire.listDomains();
				if (cancelled) return;
				setDomains(res.domains);
				const reportMap: Record<string, DomainReportResult> = {};
				await Promise.all(
					res.domains.map(async d => {
						try {
							const r = await wire.domainReport(d.id);
							reportMap[d.id] = r;
						} catch {
							// 单域战报失败不影响其它域
						}
					}),
				);
				if (!cancelled) setReports(reportMap);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const toggleExpand = (id: string): void => {
		setExpanded(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	if (error) {
		return (
			<div style={panelStyle}>
				<div style={{ fontWeight: 600, marginBottom: "8px" }}>CEO 工作台</div>
				<div style={{ color: "var(--errorForeground, #c00)" }}>{error}</div>
			</div>
		);
	}

	if (!domains) {
		return (
			<div style={panelStyle}>
				<div style={{ fontWeight: 600, marginBottom: "8px" }}>CEO 工作台</div>
				<div style={{ opacity: 0.7 }}>加载中…</div>
			</div>
		);
	}

	return (
		<div style={panelStyle}>
			<div style={{ fontWeight: 600, marginBottom: "8px" }}>CEO 工作台</div>

			<div style={{ fontWeight: 600, marginBottom: "6px", opacity: 0.85 }}>域级战报</div>
			{domains.filter(d => d.id !== "__ungrouped__").length === 0 ? (
				<div style={{ opacity: 0.7 }}>暂无域。域声明 = agent 注册（registry.json）的 domain 字段。</div>
			) : (
				domains
					.filter(d => d.id !== "__ungrouped__")
					.map(domain => {
						const report = reports[domain.id];
						const isOpen = expanded.has(domain.id);
						return (
							<div key={domain.id} style={reportCardStyle}>
								<button
									type="button"
									style={{
										fontWeight: 600,
										display: "flex",
										alignItems: "center",
										gap: "6px",
										cursor: "pointer",
										width: "100%",
										textAlign: "left",
										background: "none",
										border: "none",
										padding: 0,
										color: "inherit",
									}}
									onClick={() => toggleExpand(domain.id)}
								>
									<span>{isOpen ? "▼" : "▶"}</span>
									<span>{domain.name}</span>
									{domain.leadAgentId ? (
										<span style={{ fontSize: "10px", opacity: 0.7 }}>域 agent：{domain.leadAgentId}</span>
									) : null}
								</button>
								{report?.report ? (
									<>
										<div style={{ opacity: 0.6, fontSize: "10px", marginTop: "4px" }}>
											战报更新：{report.updatedAt ? new Date(report.updatedAt).toLocaleString() : "未知"}
										</div>
										<pre style={reportTextStyle}>{report.report}</pre>
									</>
								) : (
									<div style={{ opacity: 0.6, marginTop: "4px" }}>
										暂无战报（域 agent 的 context/summary.md 尚未生成——goal-1 摄入跑过后出现）
									</div>
								)}
								{isOpen ? (
									<div style={{ marginTop: "8px" }}>
										<div style={{ opacity: 0.75, marginBottom: "4px" }}>域内员工 agent</div>
										{domain.agents.map(agent => (
											<span key={agent.id} style={agentChipStyle}>
												{agent.name}
												{agent.skillsCount !== undefined ? ` · ${agent.skillsCount} 技能` : ""}
												{agent.phase ? ` · ${agent.phase}` : ""}
											</span>
										))}
									</div>
								) : null}
							</div>
						);
					})
			)}

			<div style={{ fontWeight: 600, marginTop: "14px", marginBottom: "6px", opacity: 0.85 }}>跨域事项</div>
			<div style={{ opacity: 0.6 }}>
				暂无（MVP 占位——待域 agent 上报需 CEO 判断/协调的事项：交期冲突、产出异常、资源协调）
			</div>
		</div>
	);
}
