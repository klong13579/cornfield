# 03: wire 配置命令（get_config / set_config）

**What to build:** 让前端能统一读写 omp 平台配置：`get_config`（读 config.yml 的域，如模型/thinking/技能开关/权限策略）、`set_config`（写指定域并持久化）。现有仅分散写命令（set_skill_enabled / set_model_disabled 直写 config.yml），本次补齐通用读写面——未来设置面板（IDE/web）不再各写一套。写路径需保持与现有分散命令的兼容（同一份 config.yml，不双写）。

**Blocked by:** None（可立即开工）

**Status:** ready-for-agent

**File scope:** packages/pi-wire（命令 schema）、packages/coding-agent（serve 端实现，读写 ~/.omp/agent/config.yml）、wire-server 集成测试。

- [ ] get_config/set_config 读写 config.yml 往返一致（改一处处处生效）
- [ ] 与现有 set_skill_enabled/set_model_disabled 并存不冲突（同一文件同一 schema）
- [ ] `bun test` 相关用例全绿

---
*来源：v3-architecture 阶段 0 + §6 配置统一（D16）；spec Implementation Decision #6*
