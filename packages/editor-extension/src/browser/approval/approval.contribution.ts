import { Injectable } from "@opensumi/di";
import { ClientAppContribution, Domain } from "@opensumi/ide-core-browser";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { getWireClient } from "../wire/client";
import { PermissionHost } from "./permission-host";
import { permissionStore } from "./permission-store";

/**
 * ApprovalContribution —— 审批卡内嵌（票 09）。
 *
 * 订阅 wire permission_request push → PermissionStore → PermissionHost 浮层渲染
 * 审批卡/澄清卡；决策走 permission_respond 回传 serve（与 web-app 同一 schema）。
 */
@Injectable()
@Domain(ClientAppContribution)
export class ApprovalContribution implements ClientAppContribution {
	initialize(): void {
		const wire = getWireClient();
		wire.ensureConnected();
		wire.onPush(event => {
			if (event.type === "permission_request") {
				permissionStore.set(event);
			}
		});

		const host = document.createElement("div");
		host.id = "omp-permission-host";
		document.body.appendChild(host);
		createRoot(host).render(createElement(PermissionHost));
	}
}
