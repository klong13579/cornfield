import { Autowired, Injectable } from "@opensumi/di";
import { ClientAppContribution, Domain } from "@opensumi/ide-core-browser";
import type { View, ViewContainerOptions } from "@opensumi/ide-core-browser/lib/layout";
import { IMainLayoutService } from "@opensumi/ide-main-layout/lib/common/main-layout.definition";
import { GitPanelView } from "./git-view";

/**
 * GitContribution —— IDE Git 面板（票 11）。
 *
 * 注册侧栏 Git 视图（status/diff/log/branches + 提交入口），消费 wire git_* 命令。
 */
@Injectable()
@Domain(ClientAppContribution)
export class GitContribution implements ClientAppContribution {
	@Autowired(IMainLayoutService)
	private readonly layoutService: IMainLayoutService;

	initialize(): void {
		const view: View = {
			id: "omp-git",
			name: "Git",
			description: "Git status/diff/log/branches + 提交入口",
			component: GitPanelView,
		};
		const options: ViewContainerOptions = {
			containerId: "omp-git",
			iconClass: "git-branch",
		};
		this.layoutService.collectTabbarComponent([view], options, "view");
	}
}
