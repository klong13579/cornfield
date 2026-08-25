import { Autowired, Injectable } from "@opensumi/di";
import { ClientAppContribution, Domain } from "@opensumi/ide-core-browser";
import { IFileServiceClient } from "@opensumi/ide-file-service/lib/common";
import { getWireClient } from "../wire/client";
import { OMP_AGENT_SCHEME, OmpAgentFileSystemProvider } from "./omp-agent-fs-provider";

/**
 * FileSystemContribution —— 注册 omp-agent:// scheme 的 FileSystemProvider（票 06）。
 *
 * IDE 文件树/编辑器对 `omp-agent://` 的资源读写统一走 wire fs_* 命令，
 * agent workspace 由此以只读预览呈现，显式授权后（provider.setAuthorized）可编辑。
 */
@Injectable()
@Domain(ClientAppContribution)
export class FileSystemContribution implements ClientAppContribution {
	@Autowired(IFileServiceClient)
	private readonly fileServiceClient: IFileServiceClient;

	private provider: OmpAgentFileSystemProvider | undefined;

	initialize(): void {
		this.provider = new OmpAgentFileSystemProvider(getWireClient());
		this.fileServiceClient.registerProvider(OMP_AGENT_SCHEME, this.provider);
	}

	/** 供审批/授权 UI 在用户决策后切换写能力。 */
	authorizeAgentWorkspace(authorized: boolean): void {
		this.provider?.setAuthorized(authorized);
	}
}
