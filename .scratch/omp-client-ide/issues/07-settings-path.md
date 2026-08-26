# 07: 设置通路（偏好改道 + 设置面板经 wire 读写 omp 配置）

**What to build:** 让 IDE 设置读写 omp 配置、不产生第二份平台配置：OpenSumi 偏好持久化重定向（preferenceDirName 系列，不落 ~/.sumi 平台设置，D16）；设置面板（或等价 UI）经 wire get_config/set_config 读写 omp 配置；OpenSumi 偏好仅存 IDE 瞬时视图状态（布局/面板开关）。

**Blocked by:** 03（wire 配置命令）、05（壳骨架）

**Status:** ready-for-agent

**File scope:** packages/editor-extension（偏好配置重定向 + 设置面板绑定 wire 命令）；消费 packages/pi-wire get_config/set_config。

- [ ] IDE 里改设置 → 写入 omp config.yml（改一处处处生效）
- [ ] ~/.sumi 不再出现平台设置持久化（仅 IDE 瞬时态可存在）
- [ ] web-app 与 IDE 读到同一份配置（往返一致）
- [ ] 验收：设置面板改模型/thinking 后，IDE 内 agent 会话立即生效

---
*来源：v3-architecture §6 配置统一（D16）+ 阶段 B2；spec Implementation Decision #6*
