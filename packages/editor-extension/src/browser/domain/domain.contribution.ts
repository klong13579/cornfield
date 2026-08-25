import { Autowired, Injectable } from "@opensumi/di";
import { ClientAppContribution, Domain } from "@opensumi/ide-core-browser";
import type { View, ViewContainerOptions } from "@opensumi/ide-core-browser/lib/layout";
import { IMainLayoutService } from "@opensumi/ide-main-layout/lib/common/main-layout.definition";
import { DomainView } from "./domain-view";

/**
 * DomainContribution —— 域管理视图（B1，D8/D10）。
 *
 * 注册侧栏域视图（域列表 + 域内 agent + 域 agent），数据来自 wire list_domains
 * （域声明聚合自 agent 注册的 domain 字段）。
 */
@Injectable()
@Domain(ClientAppContribution)
export class DomainContribution implements ClientAppContribution {
	@Autowired(IMainLayoutService)
	private readonly layoutService: IMainLayoutService;

	initialize(): void {
		const view: View = {
			id: "omp-domains",
			name: "域管理",
			description: "域列表 + 域内 agent（B1）",
			component: DomainView,
		};
		const options: ViewContainerOptions = {
			containerId: "omp-domains",
			iconClass: "team",
		};
		this.layoutService.collectTabbarComponent([view], options, "view");
	}
}
