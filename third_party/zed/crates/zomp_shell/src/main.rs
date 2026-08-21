//! ZOMP-SHELL：AppKit 单窗口壳 —— 顶部模式切换条 [Agent | IDE]。
//!
//! 目标（T2 seam，编译级交付）：
//! 1. 单个宿主 NSWindow（AppKit）作为壳
//! 2. 顶部模式切换条：`Agent` | `IDE` 两个按钮
//! 3. IDE 模式 = GPUIView 内嵌（复用 P0 的 `WindowOptions::embedded_in`，
//!    参考 `crates/omp_embed_spike/src/main.rs`）
//! 4. Agent 模式 = WKWebView（链接 WebKit，加载占位 URL）
//! 5. 切换 = 对应视图挂载 / 卸载（mount / unmount）
//!
//! 运行：`cargo run -p zomp_shell`（需 GUI 会话；headless CI 无意义）
//! 编译级验证：`cargo check -p zomp_shell`
//!
//! 生命周期与线程约束（与 P0 spike 一致）：
//! - 宿主窗口必须在 `application().run` 回调内创建（gpui 先注册 GPUIApplication 子类）
//! - 壳状态是主线程单例（`SHELL_PTR`），AppKit 按钮回调只做「排队」，真正挂载/卸载
//!   通过 `AsyncApp::spawn` 延迟到下一轮 foreground tick，避免在 gpui 持锁期间重入。

use std::ffi::c_void;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use cocoa::appkit::{NSApplication, NSBackingStoreBuffered, NSWindowStyleMask};
use cocoa::base::{id, nil};
use cocoa::foundation::{NSAutoreleasePool, NSString, NSPoint, NSRect, NSSize};
use gpui::{
    App, AsyncApp, Bounds, Context, Point, Render, Window, WindowBounds, WindowHandle, WindowOptions,
    div, prelude::*, px, rgb, size,
};
use gpui_platform::application;
use objc::{class, declare::ClassDecl, msg_send, runtime::{NO, Object, Sel, YES}, sel, sel_impl};

// WebKit.framework 链接：WKWebView / WKWebViewConfiguration 等符号在运行时由
// `objc_getClass` 解析，但需要 WebKit.framework 被链接进二进制，否则首次
// `class!(WKWebView)` 会返回 nil 并在后续 msg_send 时崩溃。
#[link(name = "WebKit", kind = "framework")]
extern "C" {}

// ---------------------------------------------------------------------------
// 几何常量（AppKit 坐标：origin 在左下角，y 轴向上）
// ---------------------------------------------------------------------------

const WINDOW_WIDTH: f64 = 900.0;
const WINDOW_HEIGHT: f64 = 700.0;
const TOP_BAR_HEIGHT: f64 = 40.0;
const CONTENT_HEIGHT: f64 = WINDOW_HEIGHT - TOP_BAR_HEIGHT;

/// Agent 模式 WKWebView 加载 URL（env `ZOMP_WEBAPP_URL` 可覆盖）。
/// 默认指向本机 7890（sidecar / web-app 联调入口）；也可设为 `about:blank` 纯占位。
const DEFAULT_WEBAPP_URL: &str = "http://127.0.0.1:7890";
const WEBAPP_URL_ENV: &str = "ZOMP_WEBAPP_URL";

/// sidecar 拉起配置（spawn 语义参考 packages/desktop/src/sidecar.ts）：
/// - 触发：env `ZOMP_SIDECAR=1` 时壳启动同时拉起 `omp serve` sidecar
/// - 标记：子进程注入 `OMP_SIDECAR=1`（供外部端口归属探测区分我方 sidecar）
const SIDECAR_TRIGGER_ENV: &str = "ZOMP_SIDECAR";
const SIDECAR_MARKER_ENV: &str = "OMP_SIDECAR";
const SIDECAR_HOST: &str = "127.0.0.1";
const SIDECAR_PORT: &str = "7891";

/// 读取 Agent 模式加载 URL：env 优先，缺省回退默认地址。
fn webapp_url() -> String {
    std::env::var(WEBAPP_URL_ENV).unwrap_or_else(|_| DEFAULT_WEBAPP_URL.to_owned())
}

// ---------------------------------------------------------------------------
// 模式
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Agent,
    Ide,
}

// ---------------------------------------------------------------------------
// IDE 模式的 gpui 根视图（内嵌 GPUIView 的内容）
// ---------------------------------------------------------------------------

struct IdeView;

impl IdeView {
    fn new() -> Self {
        Self
    }
}

impl Render for IdeView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0x1e1e1e))
            .justify_center()
            .items_center()
            .text_lg()
            .text_color(rgb(0xffffff))
            .child(format!("Zomp IDE mode — GPUI embedded in host NSWindow"))
    }
}

// ---------------------------------------------------------------------------
// 壳状态：主线程单例（通过 SHELL_PTR 裸指针访问）
// ---------------------------------------------------------------------------

/// 指向堆上 `Shell` 的裸指针；0 表示尚未初始化。所有读写均在 AppKit 主线程。
static SHELL_PTR: AtomicUsize = AtomicUsize::new(0);

fn shell_mut() -> &'static mut Shell {
    let ptr = SHELL_PTR.load(Ordering::SeqCst);
    assert_ne!(ptr, 0, "zomp_shell: Shell 尚未初始化");
    unsafe { &mut *(ptr as *mut Shell) }
}

struct Shell {
    mode: Mode,
    /// 内容区 NSView：模式视图（GPUIView / WKWebView）挂载的目标容器
    content_area: id,
    /// Agent 模式的 WKWebView；挂载到 content_area 时存在
    web_view: Option<id>,
    /// IDE 模式的 gpui 内嵌窗口句柄；挂载到 content_area 时存在
    ide_window: Option<WindowHandle<IdeView>>,
    /// 用于在 AppKit 按钮回调里安全重入 gpui（foreground executor）
    async_app: AsyncApp,
}

impl Shell {
    fn new(async_app: AsyncApp, cx: &mut App) -> Self {
        let host_window = create_host_window();
        let content_view: id = unsafe { msg_send![host_window, contentView] };

        // 顶部切换条 + 内容区：都挂在宿主窗口 contentView 之下
        let top_bar = new_view(NSRect::new(
            NSPoint::new(0.0, CONTENT_HEIGHT),
            NSSize::new(WINDOW_WIDTH, TOP_BAR_HEIGHT),
        ));
        let content_area = new_view(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(WINDOW_WIDTH, CONTENT_HEIGHT),
        ));

        unsafe {
            let _: () = msg_send![content_view, addSubview: top_bar];
            let _: () = msg_send![content_view, addSubview: content_area];
        }

        build_mode_bar(top_bar);

        let mut shell = Self {
            mode: Mode::Agent,
            content_area,
            web_view: None,
            ide_window: None,
            async_app,
        };
        // 初始模式：IDE（内嵌 GPUIView，主展示路径）。
        // 首次挂载必须用 run 回调的 cx 直接 open_window——async_app.open_window 会
        // 在 run 回调持有 App 时重入（RefCell already borrowed，运行时实测 panic）。
        shell.mount_with_cx(Mode::Ide, cx);
        shell
    }

    /// 无前置状态地挂载目标视图（启动时使用；`switch_to` 复用挂载后的重排）。
    fn mount(&mut self, target: Mode) {
        match target {
            Mode::Agent => self.mount_agent(),
            Mode::Ide => self.mount_ide(),
        }
        self.mode = target;
        self.relayout_content();
    }

    /// 启动时专用：IDE 首挂走 run 回调的 `cx`（async_app 在同一上下文重入会 panic）。
    fn mount_with_cx(&mut self, target: Mode, cx: &mut App) {
        match target {
            Mode::Agent => self.mount_agent(),
            Mode::Ide => self.mount_ide_with_cx(cx),
        }
        self.mode = target;
        self.relayout_content();
    }

    /// 用户切换：先卸载当前视图，再挂载目标视图（挂载后统一重排）。
    fn switch_to(&mut self, target: Mode) {
        eprintln!("[zomp] switch_to: mode={:?} -> {target:?}", self.mode);
        if self.mode == target {
            return;
        }
        self.unmount_current();
        self.mount(target);
    }

    fn unmount_current(&mut self) {
        match self.mode {
            Mode::Agent => self.unmount_agent(),
            Mode::Ide => self.unmount_ide(),
        }
    }

    // --- Agent 模式：WKWebView ---

    fn mount_agent(&mut self) {
        let web_view = create_web_view(&webapp_url(), WINDOW_WIDTH, CONTENT_HEIGHT);
        unsafe {
            let _: () = msg_send![self.content_area, addSubview: web_view];
        }
        self.web_view = Some(web_view);
    }

    fn unmount_agent(&mut self) {
        if let Some(web_view) = self.web_view.take() {
            unsafe {
                let _: () = msg_send![web_view, removeFromSuperview];
                let _: () = msg_send![web_view, release];
            }
        }
    }

    // --- IDE 模式：GPUIView（embedded_in） ---

    fn mount_ide(&mut self) {
        eprintln!("[zomp] mount_ide begin");
        let content_area = self.content_area as *mut c_void;
        let handle = self
            .async_app
            .open_window(
                WindowOptions {
                    embedded_in: Some(content_area),
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Point::new(px(0.0), px(0.0)),
                        size(px(WINDOW_WIDTH as f32), px(CONTENT_HEIGHT as f32)),
                    ))),
                    titlebar: None,
                    show: false, // 宿主窗口已 makeKeyAndOrderFront，gpui 窗口无需自行显示
                    focus: false,
                    ..Default::default()
                },
                |_window, cx| cx.new(|_| IdeView::new()),
            )
            .expect("zomp_shell: 内嵌 IDE 窗口打开失败");
        self.ide_window = Some(handle);
    }

    /// 启动时专用：用 run 回调的 `cx` 打开内嵌窗口（AsyncApp 同一上下文重入会 RefCell panic）。
    fn mount_ide_with_cx(&mut self, cx: &mut App) {
        let content_area = self.content_area as *mut c_void;
        let handle = cx
            .open_window(
                WindowOptions {
                    embedded_in: Some(content_area),
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Point::new(px(0.0), px(0.0)),
                        size(px(WINDOW_WIDTH as f32), px(CONTENT_HEIGHT as f32)),
                    ))),
                    titlebar: None,
                    show: false, // 宿主窗口已 makeKeyAndOrderFront，gpui 窗口无需自行显示
                    focus: false,
                    ..Default::default()
                },
                |_window, cx| cx.new(|_| IdeView::new()),
            )
            .expect("zomp_shell: 内嵌 IDE 窗口打开失败");
        self.ide_window = Some(handle);
    }

    fn unmount_ide(&mut self) {
        if let Some(handle) = self.ide_window.take() {
            // 关闭内嵌窗口：经由 gpui 上下文置 removed 标记，触发窗口侧 teardown
            let mut async_cx = self.async_app.clone();
            let _ = handle.update(&mut async_cx, |_view, window, _cx| window.remove_window());
        }
    }

    /// 切换后强制内容区重新布局：触发 AppKit 布局 pass，并刷新 WKWebView frame
    /// 使其填满 content_area（内嵌 GPUIView 已带 autoresizing 掩码，跟随 superview）。
    fn relayout_content(&self) {
        unsafe {
            let _: () = msg_send![self.content_area, setNeedsLayout: YES];
            let _: () = msg_send![self.content_area, layoutSubtreeIfNeeded];
            if self.mode == Mode::Agent {
                if let Some(web_view) = self.web_view {
                    let frame = NSRect::new(
                        NSPoint::new(0.0, 0.0),
                        NSSize::new(WINDOW_WIDTH, CONTENT_HEIGHT),
                    );
                    let _: () = msg_send![web_view, setFrame: frame];
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// AppKit 宿主窗口 / 视图构造
// ---------------------------------------------------------------------------

/// 创建宿主 NSWindow：alloc + init，顶部切换条与内容区随后挂到其 contentView。
fn create_host_window() -> id {
    unsafe {
        let rect = NSRect::new(
            NSPoint::new(100.0, 100.0),
            NSSize::new(WINDOW_WIDTH, WINDOW_HEIGHT),
        );
        let style_mask = NSWindowStyleMask::NSTitledWindowMask
            | NSWindowStyleMask::NSClosableWindowMask
            | NSWindowStyleMask::NSResizableWindowMask;

        let _pool = NSAutoreleasePool::new(nil);
        let app = NSApplication::sharedApplication(nil);

        let window: id = msg_send![class!(NSWindow), alloc];
        let window: id = msg_send![
            window,
            initWithContentRect: rect
            styleMask: style_mask
            backing: NSBackingStoreBuffered
            defer: NO
        ];
        assert!(!window.is_null(), "zomp_shell: 宿主窗口创建失败");

        let title = NSString::alloc(nil).init_str("OMP · Zomp Shell");
        let _: () = msg_send![window, setTitle: title];
        let _: () = msg_send![window, setReleasedWhenClosed: NO];
        // 无 bundle 的 CLI 进程 activation policy 默认不保证 Regular；显式设置
        let _: () = msg_send![app, setActivationPolicy: 0]; // NSApplicationActivationPolicyRegular
        let _: () = msg_send![window, makeKeyAndOrderFront: nil];
        let _: () = msg_send![app, activateIgnoringOtherApps: true];

        window
    }
}

fn new_view(frame: NSRect) -> id {
    unsafe {
        let view: id = msg_send![class!(NSView), alloc];
        let view: id = msg_send![view, initWithFrame: frame];
        assert!(!view.is_null(), "zomp_shell: NSView 创建失败");
        view
    }
}

// ---------------------------------------------------------------------------
// 模式切换条（顶部 [Agent | IDE]）
// ---------------------------------------------------------------------------

fn build_mode_bar(top_bar: id) {
    let agent_button = make_button("Agent", sel!(switchToAgent:));
    let ide_button = make_button("IDE", sel!(switchToIde:));

    unsafe {
        let _: () = msg_send![
            agent_button,
            setFrame: NSRect::new(NSPoint::new(10.0, 5.0), NSSize::new(100.0, 30.0))
        ];
        let _: () = msg_send![
            ide_button,
            setFrame: NSRect::new(NSPoint::new(120.0, 5.0), NSSize::new(100.0, 30.0))
        ];
        let _: () = msg_send![top_bar, addSubview: agent_button];
        let _: () = msg_send![top_bar, addSubview: ide_button];
    }
}

fn make_button(title: &str, action: Sel) -> id {
    unsafe {
        let button: id = msg_send![class!(NSButton), alloc];
        let button: id = msg_send![
            button,
            initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0))
        ];
        let title_str = NSString::alloc(nil).init_str(title);
        let _: () = msg_send![button, setTitle: title_str];
        let _: () = msg_send![button, setBezelStyle: 1]; // NSBezelStyleRounded
        let _: () = msg_send![button, setTarget: controller()];
        let _: () = msg_send![button, setAction: action];
        button
    }
}

// ---------------------------------------------------------------------------
// 按钮 target：ZompShellController（NSObject 子类），action 里只排队、不直接动视图
// ---------------------------------------------------------------------------

/// 注册 `ZompShellController` 类（进程内一次）。action 方法签名与 AppKit 约定一致。
fn build_controller_class() {
    unsafe {
        let mut decl = ClassDecl::new("ZompShellController", class!(NSObject)).unwrap();
        decl.add_method(
            sel!(switchToAgent:),
            switch_to_agent as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(switchToIde:),
            switch_to_ide as extern "C" fn(&Object, Sel, id),
        );
        decl.register();
    }
}

fn controller() -> id {
    static CONTROLLER_PTR: AtomicUsize = AtomicUsize::new(0);
    let existing = CONTROLLER_PTR.load(Ordering::SeqCst);
    if existing != 0 {
        return existing as id;
    }
    let instance: id = unsafe { msg_send![class!(ZompShellController), new] };
    CONTROLLER_PTR.store(instance as usize, Ordering::SeqCst);
    instance
}

extern "C" fn switch_to_agent(_this: &Object, _sel: Sel, _sender: id) {
    request_switch(Mode::Agent);
}

extern "C" fn switch_to_ide(_this: &Object, _sel: Sel, _sender: id) {
    request_switch(Mode::Ide);
}

/// AppKit 回调线程上：把切换请求排队到 foreground executor，避免在 gpui 持锁
/// 期间重入（与 P0 spike 的「GCD 延迟注入」同理）。
fn request_switch(target: Mode) {
    eprintln!("[zomp] request_switch -> {target:?}");
    let async_app = shell_mut().async_app.clone();
    async_app
        .spawn(async move |_async_cx| {
            eprintln!("[zomp] switch task running, target={target:?}");
            shell_mut().switch_to(target);
            eprintln!("[zomp] switch done");
        })
        .detach();
}

// ---------------------------------------------------------------------------
// Agent 模式：WKWebView 构造
// ---------------------------------------------------------------------------

fn create_web_view(url: &str, width: f64, height: f64) -> id {
    unsafe {
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
        let config: id = msg_send![class!(WKWebViewConfiguration), new];
        let web_view: id = msg_send![class!(WKWebView), alloc];
        let web_view: id = msg_send![web_view, initWithFrame: frame configuration: config];

        let url_str = NSString::alloc(nil).init_str(url);
        let ns_url: id = msg_send![class!(NSURL), URLWithString: url_str];
        let request: id = msg_send![class!(NSURLRequest), requestWithURL: ns_url];
        let _: () = msg_send![web_view, loadRequest: request];

        web_view
    }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// 壳启动时按需拉起 `omp serve` sidecar（spawn 语义参考 packages/desktop/src/sidecar.ts）：
/// - 仅当 env `ZOMP_SIDECAR=1` 时拉起
/// - 命令 `omp serve --port 7891 --host 127.0.0.1`，stdio 忽略（脱离终端），
///   注入 `OMP_SIDECAR=1` 标记供外部端口归属探测
/// - spawn 失败降级：仅打印日志，不阻塞壳启动
fn maybe_spawn_sidecar() {
    if std::env::var(SIDECAR_TRIGGER_ENV).as_deref() != Ok("1") {
        return;
    }
    let spawn = Command::new("omp")
        .args(["serve", "--port", SIDECAR_PORT, "--host", SIDECAR_HOST])
        .env(SIDECAR_MARKER_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match spawn {
        Ok(_child) => {
            eprintln!(
                "[zomp_shell] sidecar spawned: omp serve --port {SIDECAR_PORT} --host {SIDECAR_HOST}"
            );
        }
        Err(err) => {
            // 降级：sidecar 拉起失败（omp 未安装 / 不在 PATH）不阻塞壳启动。
            eprintln!("[zomp_shell] sidecar spawn failed (degraded, shell continues): {err}");
        }
    }
}

fn main() {
    build_controller_class();
    maybe_spawn_sidecar();

    application().run(|cx| {
        let async_app = cx.to_async();
        let shell = Shell::new(async_app, cx);
        // 壳状态移交堆上单例，供按钮回调访问；进程生命周期内不释放。
        SHELL_PTR.store(Box::into_raw(Box::new(shell)) as usize, Ordering::SeqCst);

        // 自动切换自测（ZOMP_AUTO_SWITCH_TEST=1，dev 工具）：GCD 主队列调度
        // （request_switch -> AsyncApp::spawn 是 spawn_local，必须在主线程触发；
        //  std::thread 触发实测 panic "local task polled by a thread that didn't spawn it"）。
        if std::env::var("ZOMP_AUTO_SWITCH_TEST").is_ok() {
            let q = dispatch2::Queue::main();
            let dt = |ms: u64| dispatch2::DispatchTime::try_from(std::time::Duration::from_millis(ms)).expect("time");
            let _ = q.after(dt(2000), || { eprintln!("[zomp] AUTO: -> Agent"); request_switch(Mode::Agent); });
            let _ = q.after(dt(5000), || { eprintln!("[zomp] AUTO: -> Ide"); request_switch(Mode::Ide); });
            let _ = q.after(dt(8000), || { eprintln!("[zomp] AUTO: -> Agent"); request_switch(Mode::Agent); });
        }
    });
}
