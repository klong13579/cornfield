import { Autowired, Injectable } from "@opensumi/di";
import { ClientAppContribution, Domain } from "@opensumi/ide-core-browser";
import type { View, ViewContainerOptions } from "@opensumi/ide-core-browser/lib/layout";
import { IMainLayoutService } from "@opensumi/ide-main-layout/lib/common/main-layout.definition";
import { CeoWorkbenchView } from "./ceo-workbench-view";

/**
 * CeoWorkbenchContribution —— CEO 工作台第一屏（B2，D11）。
 *
 * 注册侧栏 CEO 工作台视图（域级战报卡 + 跨域事项区 + 下钻员工明细），
 * 数据来自 wire list_domains + domain_report。
 */
@Injectable()
@Domain(ClientAppContribution)
export class CeoWorkbenchContribution implements ClientAppContribution {
	@Autowired(IMainLayoutService)
	private readonly layoutService: IMainLayoutService;

	initialize(): void {
		const view: View = {
			id: "omp-ceo-workbench",
			name: "CEO 工作台",
			description: "域级战报 + 跨域事项 + 下钻（B2）",
			component: CeoWorkbenchView,
		};
		const options: ViewContainerOptions = {
			containerId: "omp-ceo-workbench",
			iconClass: "detail",
		};
		this.layoutService.collectTabbarComponent([view], options, "view");
	}
}
