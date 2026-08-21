//! ZOMP-SHELL 独立 bin：薄包装 `zomp_shell::run_standalone()`。
//!
//! 完整壳逻辑见 `zomp_shell` 库（`src/lib.rs`）；zed 主程序通过 `ZOMP_SHELL=1`
//! 复用同一套库进入单窗口壳模式（IDE = 真实 workspace）。

fn main() {
    zomp_shell::run_standalone();
}
