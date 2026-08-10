# Zed spawn oh-my-pi agent: fail to launch, 9 (SIGKILL)

**作者**: Pi staff engineer
**日期**: 2026-08-10
**触发问题**: Zed 1.14.2 (hardened runtime) 通过 `agent_servers.oh-my-pi` spawn `~/.local/bin/omp --mode acp` 作为 ACP agent server, 子进程被 macOS 杀掉 (exit 137 / SIGKILL), 弹窗 `Failed to launch / Server exited with status signal: 9 (SIGKILL)`
**结论摘要**: `bun run build` 产出的 omp 二进制是 ad-hoc 签名 (`flags=0x2(adhoc)`), 没有 hardened runtime flag; Zed 是 hardened runtime 进程 (`flags=0x10000(runtime)`); macOS 拒绝 hardened 父进程 spawn 非 hardened 子进程. 给 omp 二进制重签加 hardened runtime + 必要 entitlements 解决

---

## 1. 现象

Zed 1.14.2 配置 `agent_servers.oh-my-pi` 指向 `~/.local/bin/omp --mode acp`. 新建 oh-my-pi thread 时 Zed 试图 spawn omp, 立即弹窗:

```
Failed to launch
Server exited with status signal: 9 (SIGKILL)
```

退出码 137 = 128 + 9 (SIGKILL). macOS 阻止了 spawn — 弹窗类似 NSAlert, **不写 Zed 日志**, 也不出现在 `dev: open acp logs` 之外的可观测路径. 因此诊断时容易被误判为 LLM provider 错误.

与 GitHub issue [zed-industries/zed#58276](https://github.com/zed-industries/zed/issues/58276) (Junie agent fail to launch) 表现完全一致 — 该 issue open 数月未修.

## 2. 误诊路径（记录以避免重蹈）

### 2.1 误诊 1: 归因 LLM provider

最初日志反复出现 `Failed to authenticate provider: ChatGPT Subscription: Sign in with your ChatGPT Plus or Pro subscription to use this provider.`, 推测 Zed 默认 LLM provider 未登录导致 fail to launch.

排查:
- 加 `show_edit_predictions: false` — 无效, 弹窗仍弹
- 加 `disable_ai: true` — 弹窗消失但 Agent Panel 也被关掉, 用户拒绝. 撤掉

根因: `Failed to authenticate provider` 是 agent provider (Zed Agent Panel 内置的 ChatGPT 后端) 错误, **与 agent server spawn 是两条独立路径**. 日志里的 ChatGPT 错误和 Zed 弹窗没有因果关系 — 两条都是 LLM-driven UI 在用户没登录订阅时的告警, 但 spawn SIGKILL 的真凶不在这里.

教训: **当多个相关错误同时存在, 不要被高频出现的错误带偏方向**. 弹窗 `fail to launch, 9 (SIGKILL)` 的退出码 9 是 SIGKILL, macOS 内核级 kill, 与认证失败 (exit 1) 完全不同.

### 2.2 误诊 2: 归因 acp-agent.ts 改动

将所有 acp-agent.ts 改动 (thinking messageId 合并 / builtin 路由) 分两批回滚:
- 先回滚 builtin 暴露 (available_commands_update 里加的 5 个 builtin) — 仍报
- 再回滚 #1 messageId 稳定化 — 仍报
- 最后 stash 全部改动 (git stash push -- packages/coding-agent/src/modes/acp/acp-agent.ts) — 仍报

最终 `git diff --stat HEAD` 为空, 但弹窗依旧. 确认 acp-agent.ts 不是问题源.

教训: **当回滚所有改动后问题仍存在, 才考虑外部因素** (binary 自身 / 父进程配置 / macOS / Zed 配置). 不要反复怀疑"还有哪个改动忘了回滚".

## 3. 真根因 — hardened runtime 签名不匹配

### 3.1 macOS 机制

macOS 的 hardened runtime 标志 (`flags=0x10000(runtime)`) 让进程在严格的沙箱约束下运行, 包括:
- 只能加载经签名的代码
- 不能注入任意动态库
- 不能在没有 entitlement 的情况下执行 JIT
- **spawn 子进程时, 子进程也必须满足 hardened runtime 约束** (否则 macOS 杀子进程)

Zed 是 hardened runtime 进程 (官方 Developer ID 签名 + hardened runtime). 当 Zed 试图 spawn 子进程 (我们的 omp), macOS 内核会检查子进程:
- 必须有 Developer ID 签名 + hardened runtime; 或
- 父进程有 `com.apple.security.cs.allow-unsigned-executable-memory` 等 entitlement 来放行; 或
- 子进程被用户/系统授权

`bun build --compile` 产出的二进制默认是 **ad-hoc 签名 + 无 hardened runtime** (`flags=0x2(adhoc)`). 没有 Developer ID 证书, 没有 hardened runtime. macOS 杀.

### 3.2 验证手段

```bash
# 对比两个 binary 的签名信息
codesign -dvv /Users/sz-0203015357/.local/bin/omp
# 关键输出:
#   CodeDirectory v=20400 ... flags=0x2(adhoc) ...
#   Signature=adhoc
#   TeamIdentifier=not set

codesign -dvv /Users/sz-0203015357/Applications/Zed.app
# 关键输出:
#   CodeDirectory v=20500 ... flags=0x10000(runtime) ...
#   Authority=Developer ID Application: Zed Industries, Inc. (MQ55VZLNZQ)
#   TeamIdentifier=MQ55VZLNZQ
#   Runtime Version=15.0.0
```

`omp` 缺 hardened runtime, Zed 有. macOS 杀 omp.

### 3.3 为什么不写 Zed 日志

弹窗是 macOS 进程间 IPC 层 (Launch Services) 的拒绝, 不进入 Zed 的 agent server 启动错误处理. Zed 看到的就是"子进程退出了, exit code 9" — Zed 把它格式化显示成 `Failed to launch / Server exited with status signal: 9 (SIGKILL)`. 不写 Zed 的 stdout/stderr/log, 也不出现在 `dev: open acp logs` (那是 Zed 内部 stdout, 不会包含 macOS Launch Services 的拒绝).

## 4. 修复

### 4.1 重新签名 omp 二进制

```bash
# 1. 创建 entitlements 文件
cat > /tmp/omp.entitlements <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
</dict>
</plist>
EOF

# 2. 备份原 binary
cp ~/.local/bin/omp /tmp/omp.bak

# 3. 重签: ad-hoc + hardened runtime + entitlements
codesign --force --sign - \
  --options runtime \
  --entitlements /tmp/omp.entitlements \
  ~/.local/bin/omp

# 4. 验证签名
codesign -dvv ~/.local/bin/omp | grep -E "flags|Signature"
# 应输出: CodeDirectory v=20xxx ... flags=0x10002(adhoc,runtime) ...
#         Signature=adhoc
```

关键变化: `flags=0x2(adhoc)` → `flags=0x10002(adhoc, runtime)`. hardened runtime 加上后, Zed spawn 成功.

### 4.2 entitlements 选择的理由

四个 entitlement 都是 spawn 期间 omp 自身或它加载的 native addon (pi-natives) 可能需要的:
- `allow-unsigned-executable-memory`: bun runtime 加载代码到 executable memory
- `allow-jit`: bun runtime 的 JIT
- `disable-library-validation`: 加载 pi-natives (ad-hoc 签名的 Rust cdylib) 时不验证签名
- `allow-dyld-environment-variables`: bun 的 dyld env 变量

如果仍报 SIGKILL, 可逐个删除试, 但默认四件套是安全的 (自身不联网, 不绕过更多 macOS 安全边界).

### 4.3 验证

- 重签后 Zed spawn omp 成功, 弹窗不再出现
- `agent_thread 正常使用, thinking 显示, 工具调用, /help builtin 路由等都正常
- 用户报告 "现在正常了"

## 5. build 流程改进建议

`bun run build` 应该默认产出 hardened runtime 签名 binary. 在 `packages/coding-agent/scripts/embed-native.ts` 之后, build 脚本里加:

```bash
codesign --force --sign - \
  --options runtime \
  --entitlements scripts/omp.entitlements \
  packages/coding-agent/dist/omp
```

需要先创建 `packages/coding-agent/scripts/omp.entitlements` (内容同 §4.1).

这样:
- 开发者本地 build 出来的 binary 默认 hardened runtime
- 用户安装 (cp 到 ~/.local/bin) 后 Zed spawn 不需要手动重签
- 避免这个 trap 再次出现

## 6. 经验教训

1. **macOS hardened runtime 是 Zed / VSCode / Cursor 等现代编辑器的默认, spawn 子进程前必须确认子进程签名匹配**
2. **任何 `bun build --compile` 出来的二进制默认是 ad-hoc 签名, 没有 hardened runtime — 上生产前必须重签**
3. **SIGKILL (exit 137) 弹窗不写 Zed 日志, 诊断时要看 codesign / otool / Console.app (系统级), 不能只看 Zed.log**
4. **同时出现的多个错误 (LLM provider 认证失败 + agent server SIGKILL) 容易让人抓错方向, 优先看退出码 (9 vs 1 vs 137) 区分**
5. **回滚所有可疑改动后问题仍存在, 才考虑外部因素** (binary 签名 / macOS 配置 / 父进程 entitlement)

## 7. 相关 issue

- [zed-industries/zed#58276](https://github.com/zed-industries/zed/issues/58276) - Junie agent fail to launch / SIGKILL (open, 未修)
- [zed-industries/zed#37213](https://github.com/zed-industries/zed/issues/37213) - Failed to connect to ACP server
- [zed-industries/zed#43819](https://github.com/zed-industries/zed/issues/43819) - External agents unable to initialize after 30s
- [Apple Stack Exchange: Application get sigkill on launch](https://apple.stackexchange.com/questions/429433/application-get-sigkill-on-launch)
