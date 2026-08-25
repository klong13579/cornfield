import { Autowired, Injectable } from "@opensumi/di";
import { ClientAppContribution, Domain } from "@opensumi/ide-core-browser";
import type { View, ViewContainerOptions } from "@opensumi/ide-core-browser/lib/layout";
import { IMainLayoutService } from "@opensumi/ide-main-layout/lib/common/main-layout.definition";
import { MyAgentView } from "./my-agent-view";

/**
 * MyAgentContribution —— 我的 agent 轻视图（票 10）。
 *
 * 注册侧栏自定义视图（状态/知识库/画像/近期任务/对话入口），数据来自 omp 平台
 * wire 命令（list_agents/get_memory/get_skills/list_sessions），角色注入骨架默认员工。
 */
@Injectable()
@Domain(ClientAppContribution)
export class MyAgentContribution implements ClientAppContribution {
	@Autowired(IMainLayoutService)
	private readonly layoutService: IMainLayoutService;

	initialize(): void {
		const view: View = {
			id: "omp-my-agent",
			name: "我的 agent",
			description: "个人 agent 状态/知识库/画像/任务",
			priority: 10,
			component: MyAgentView,
		};
		const options: ViewContainerOptions = {
			containerId: "omp-my-agent",
			iconClass: "account",
		};
		this.layoutService.collectTabbarComponent([view], options, "view");
	}
}
