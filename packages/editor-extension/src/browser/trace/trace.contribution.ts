import { Autowired, Injectable } from "@opensumi/di";
import { ClientAppContribution, Domain } from "@opensumi/ide-core-browser";
import type { View, ViewContainerOptions } from "@opensumi/ide-core-browser/lib/layout";
import { IMainLayoutService } from "@opensumi/ide-main-layout/lib/common/main-layout.definition";
import { TraceView } from "./trace-view";

/**
 * TraceContribution —— 追溯台（B4，User Story 23）。
 *
 * 注册侧栏追溯台视图（会话/工具调用/决策回放），数据来自 wire
 * list_sessions + get_session_messages。
 */
@Injectable()
@Domain(ClientAppContribution)
export class TraceContribution implements ClientAppContribution {
	@Autowired(IMainLayoutService)
	private readonly layoutService: IMainLayoutService;

	initialize(): void {
		const view: View = {
			id: "omp-trace",
			name: "追溯台",
			description: "会话/工具调用/决策依据回放（B4）",
			component: TraceView,
		};
		const options: ViewContainerOptions = {
			containerId: "omp-trace",
			iconClass: "time-circle",
		};
		this.layoutService.collectTabbarComponent([view], options, "view");
	}
}
