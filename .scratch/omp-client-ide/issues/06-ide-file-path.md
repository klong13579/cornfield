# 06: IDE 文件通路（IFileService→wire + omp-agent:// 预览）

**What to build:** 让 IDE 里的文件系统走 omp wire：注册 OpenSumi FileSystemProvider 代理到 wire fs_* 命令；agent workspace 文件以 `omp-agent://` scheme 只读预览（从 agent 详情跳转查看工作目录，D5），显式授权后可编辑。IDE 打开/编辑/保存文件与 agent workspace 预览共用这条通路。

**Blocked by:** 01（wire fs 写命令面）、05（壳骨架）

**Status:** ready-for-agent

**File scope:** packages/editor-extension（FileSystemProvider 注册 + omp-agent:// scheme）；消费 packages/pi-wire fs_* 命令。

- [ ] IDE 文件树/编辑器打开本地项目文件，编辑保存经 wire 往返成功
- [ ] agent workspace 以 `omp-agent://` 只读预览出文件树与内容
- [ ] 授权后编辑 agent workspace 文件成功（权限边界与 D5 一致）
- [ ] 大文件（>128KB）不截断（chunked 或等价处理）

---
*来源：v3-architecture §3 数据通路 + 集成点 #6；spec Implementation Decision #4*
