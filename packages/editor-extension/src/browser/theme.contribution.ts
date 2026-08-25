import { Autowired, Injectable } from "@opensumi/di";
import { ClientAppContribution, Domain } from "@opensumi/ide-core-browser";
import { URI } from "@opensumi/ide-core-common";
import { type IThemeContribution, IThemeService } from "@opensumi/ide-theme";
import { OMP_THEME_ID } from "./agent-config";

const OMP_THEME_CONTRIBUTION: IThemeContribution = {
	id: OMP_THEME_ID,
	label: "OMP Web App",
	description: "web-app 风格亮色主题（canvas/surface/ink 三级 + 单色 accent + 克制语义色）",
	uiTheme: "vs",
	path: "omp-web-app-light.json",
	extensionId: "oh-my-pi",
};

@Injectable()
@Domain(ClientAppContribution)
export class OmpThemeContribution implements ClientAppContribution {
	@Autowired(IThemeService)
	private themeService: IThemeService;

	initialize() {
		// 主题 JSON 落在 extensionDir（server 侧可读目录，staticAllowPath 已放行），
		// 以 file:// URI 注册为 OpenSumi 自定义主题。
		const themeDir = `${process.env.EXTENSION_DIR ?? ""}/omp-web-app`;
		this.themeService.registerThemes([OMP_THEME_CONTRIBUTION], URI.file(themeDir));
	}
}
