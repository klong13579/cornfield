import type { ModelCatalogStatus } from "@cornfield/wire";
import { STATUS_META } from "./catalog-logic";

/** 六态状态徽章（互斥；title 常驻状态释义，行内与详情抽屉共用）。 */
export function StatusBadge({ status }: { status: ModelCatalogStatus }): React.JSX.Element {
	const meta = STATUS_META[status];
	return (
		<span className={`badge ${meta.badge}`} title={meta.hint}>
			{meta.label}
		</span>
	);
}
