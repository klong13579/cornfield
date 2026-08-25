import { Autowired, Injectable } from "@opensumi/di";
import { ClientAppContribution, Domain } from "@opensumi/ide-core-browser";
import type { View, ViewContainerOptions } from "@opensumi/ide-core-browser/lib/layout";
import { IMainLayoutService } from "@opensumi/ide-main-layout/lib/common/main-layout.definition";
import { ConfigView } from "./config-view";

/**
 * ConfigContribution —— 设置面板（票 07）。
 *
 * 注册一个侧栏自定义视图，读写 omp config.yml（get_config/set_config）。
 * OpenSumi 偏好持久化已由 render-app 的 preferenceDirName 系列重定向到 .omp-ide，
 * 不落 ~/.sumi 平台配置。
 */
@Injectable()
@Domain(ClientAppContribution)
export class ConfigContribution implements ClientAppContribution {
	@Autowired(IMainLayoutService)
	private readonly layoutService: IMainLayoutService;

	initialize(): void {
		const view: View = {
			id: "omp-config",
			name: "omp 设置",
			description: "读写 omp 平台配置（模型/thinking）",
			component: ConfigView,
		};
		const options: ViewContainerOptions = {
			containerId: "omp-config",
			iconClass: "setting",
		};
		this.layoutService.collectTabbarComponent([view], options, "view");
	}
}
