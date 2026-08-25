import { Autowired, Injectable } from "@opensumi/di";
import { ClientAppContribution, Domain } from "@opensumi/ide-core-browser";
import type { View, ViewContainerOptions } from "@opensumi/ide-core-browser/lib/layout";
import { IMainLayoutService } from "@opensumi/ide-main-layout/lib/common/main-layout.definition";
import { DiffReviewView } from "./diff-review-view";

/**
 * DiffContribution —— diff 审阅（票 08）。
 *
 * 注册侧栏 diff 审阅视图，消费 wire fs_diff/fs_write；待审项由 DiffReviewStore
 * 承载（agent 改动提交进来，人在视图里接受/拒绝/修改后接受）。
 */
@Injectable()
@Domain(ClientAppContribution)
export class DiffContribution implements ClientAppContribution {
	@Autowired(IMainLayoutService)
	private readonly layoutService: IMainLayoutService;

	initialize(): void {
		const view: View = {
			id: "omp-diff-review",
			name: "diff 审阅",
			description: "审阅 agent 的文件改动（接受/拒绝/修改后接受）",
			component: DiffReviewView,
		};
		const options: ViewContainerOptions = {
			containerId: "omp-diff-review",
			iconClass: "open-changes",
		};
		this.layoutService.collectTabbarComponent([view], options, "view");
	}
}
