# Changelog

## [Unreleased]

### Changed

- **逐键配置人话化策展**（`src/pages/models/config/ScopeKeysSection.tsx`, `scope-keys.ts`）: 运行配置页不再全量平铺 267 个 schema 键。精选 12 个高频键置顶（思考档位/采样温度/自动压缩/压缩阈值/压缩策略/上下文自动升级/卡死检测/API 重试/回退回归/跟进模式/自动恢复/Python 工具模式），配中文人话标签与一句话说明；其余键全部进入「高级配置」折叠组（默认收起，展开后三层展示与编辑功能完整）。纯展示层策展，协议与 schema 不变。

### Added

- **模型市场升级为模型控制中心**（`src/pages/models/**`, `src/router.tsx`）: `/models` 重定向至 `/models/catalog`，三个独立工作区——模型目录（全量已知模型六态展示、搜索/筛选/真实排序、详情抽屉、会话临时切换、连通性测试）、Provider（OAuth/API Key/Base URL/本地端点接入、状态与掩码、单 Provider/全量目录刷新、断开依赖保护与强制断开二次确认）、运行配置（全局/项目作用域、逐键三层取值、恢复继承、角色级主模型与回退链编辑器：草稿 + 保存前 diff + 原子写入）；壳层顶部状态条与异常区（含「失效待修复」派生态，重新接入后自动恢复）。

### Fixed

- **新增角色的 diff 弹窗不展示写入内容**（`src/pages/models/config/role-editor.ts`）: computeRoutesDiff 对新增角色返回 primary/fallbacks = null，保存确认弹窗只显示「新增 默认 default」而看不到将写入的主模型与回退链，违背「写入前 diff 完整可见」契约。改为新增角色也展示 from=null 的字段变更（主模型：（无） → 实际值）。

- **断连态永久骨架屏**（`src/pages/models/ModelsView.tsx`）: 未连接时渲染明确断连提示与重试入口，不再无限骨架。
- **模型切换/停用恢复静默吞错**（`src/state/session-store.ts`, 各工作区）: 命令失败写入错误态并渲染可诊断 banner。
- **面包屑子路径误配**（`src/router.tsx`）: `findPageMeta` 改最长前缀匹配，子路由不再误落 home。
- **伪「最新」筛选删除**（模型目录）: 移除以列表前两项冒充最新模型的启发式，改真实发布时间排序（缺失数据排末尾并明示）。
