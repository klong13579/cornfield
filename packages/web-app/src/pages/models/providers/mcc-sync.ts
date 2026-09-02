/**
 * Provider 写操作互斥与控制中心数据变更通知（#08 断开流竞态处理）。
 *
 * 两个机制，同一模块：
 * - 断开锁：同一时刻只允许一个 ProviderCard 处于断开进行中。断开是唯一会引发
 *   「配置引用失效」的写操作，其他 provider 的写动作在其间禁用，避免用户在
 *   依赖清单过期后继续改配置（竞态：检查结果与实际写入之间 serve 状态已变化）。
 * - 数据变更通知：ProviderCard 的写动作（断开 / 凭据 / 端点 / 目录刷新）会改变
 *   provider 状态与目录派生态，壳层（ModelsView）订阅后重拉三份数据并重新推导
 *   异常区——替代轮询，也避免壳层与子视图各自持数据后失同步。
 *
 * 模块级轻量外部状态（非 store 依赖），React 侧经 useSyncExternalStore 消费；
 * 无 DOM / window 依赖，纯 bun 单测可覆盖。
 */

// ── 断开锁 ────────────────────────────────────────────────────────────────

let disconnectHolder: string | null = null;
const lockListeners = new Set<() => void>();

/** 当前持有断开锁的 providerId；无断开进行中为 null（useSyncExternalStore 快照）。 */
export function disconnectInProgress(): string | null {
	return disconnectHolder;
}

/**
 * 申请断开锁（进入断开流程前置检查时申请）。已被其他 provider 持有时返回 false
 * （调用方按钮已禁用，这里是双保险）；同 provider 重复申请幂等返回 true。
 */
export function acquireDisconnectLock(providerId: string): boolean {
	if (disconnectHolder !== null && disconnectHolder !== providerId) return false;
	if (disconnectHolder !== providerId) {
		disconnectHolder = providerId;
		for (const cb of lockListeners) cb();
	}
	return true;
}

/** 释放断开锁（仅持锁者生效；未持锁调用为 no-op，防止乱序释放）。 */
export function releaseDisconnectLock(providerId: string): void {
	if (disconnectHolder !== providerId) return;
	disconnectHolder = null;
	for (const cb of lockListeners) cb();
}

/** 订阅断开锁变化（useSyncExternalStore subscribe 形参；返回退订函数）。 */
export function subscribeDisconnectLock(cb: () => void): () => void {
	lockListeners.add(cb);
	return () => {
		lockListeners.delete(cb);
	};
}

// ── 数据变更通知 ──────────────────────────────────────────────────────────

const dataListeners = new Set<() => void>();

/** 写动作成功后由 ProviderCard 调用：通知壳层重拉 providers/catalog/scope。 */
export function notifyMccDataChanged(): void {
	for (const cb of dataListeners) cb();
}

/** 订阅数据变更（返回退订函数）。 */
export function subscribeMccDataChanged(cb: () => void): () => void {
	dataListeners.add(cb);
	return () => {
		dataListeners.delete(cb);
	};
}
