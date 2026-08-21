//! SPIKE-P0：Zomp embedded 最小验证 —— 宿主 NSWindow + GPUIView 内嵌渲染。
//!
//! 验证目标（P0 seam）：
//! 1. GPUIView 能挂进宿主 NSWindow 的 contentView（单窗口内嵌）
//! 2. gpui 渲染/事件循环在 embedded 模式下工作（键盘/鼠标）
//! 3. display link 功耗基线（本 spike 只验证功能，功耗实测在后续步骤）
//!
//! 运行：cargo run -p omp_embed_spike（需 GUI 会话；headless CI 无意义）

use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};

use cocoa::appkit::{NSApplication, NSBackingStoreBuffered, NSWindowStyleMask};
use cocoa::base::{id, nil};
use cocoa::foundation::{NSAutoreleasePool, NSString, NSPoint, NSRect, NSSize};
use gpui::{
    App, Bounds, Context, MouseButton, MouseDownEvent, Point, SharedString, Window, WindowBounds,
    WindowOptions, div, prelude::*, px, rgb, size,
};
use gpui_platform::application;
use objc::{class, msg_send, runtime::NO, sel, sel_impl};

struct EmbeddedView {
    text: SharedString,
    clicks: usize,
}

impl Render for EmbeddedView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .bg(rgb(0x1e1e1e))
            .size_full()
            .justify_center()
            .items_center()
            .text_lg()
            .text_color(rgb(0xffffff))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::handle_click))
            .child(format!(
                "GPUI embedded in host NSWindow — clicks: {}",
                self.clicks
            ))
            .child(format!("text: {}", self.text))
    }
}

impl EmbeddedView {
    fn new() -> Self {
        Self {
            text: SharedString::from("SPIKE-P0 embedded mode OK"),
            clicks: 0,
        }
    }

    fn handle_click(
        &mut self,
        _event: &MouseDownEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.clicks += 1;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        eprintln!("[spike] handle_click t={now} clicks={}", self.clicks);
        cx.notify();
    }
}

/// 宿主 NSWindow 指针（static 便于 run loop 内重新 order）
static HOST_WINDOW: AtomicUsize = AtomicUsize::new(0);

/// 构造合成鼠标点击（window 坐标）——NSEvent down/up 对
unsafe fn make_click_events(window: id) -> (id, id) {
    let win_num: i64 = msg_send![window, windowNumber];
    let loc = NSPoint::new(450.0, 350.0);
    let down: id = msg_send![class!(NSEvent), mouseEventWithType: 1 location: loc modifierFlags: 0 timestamp: 0.0 windowNumber: win_num context: nil eventNumber: 0 clickCount: 1 pressure: 1.0];
    let up: id = msg_send![class!(NSEvent), mouseEventWithType: 2 location: loc modifierFlags: 0 timestamp: 0.0 windowNumber: win_num context: nil eventNumber: 0 clickCount: 1 pressure: 1.0];
    (down, up)
}

/// 打印宿主窗口遮挡状态（NSWindowOcclusionStateVisible = bit 0）
unsafe fn print_occlusion(tag: &str) {
    let window = HOST_WINDOW.load(Ordering::SeqCst) as id;
    let occlusion: i64 = msg_send![window, occlusionState];
    let visible_bit = occlusion & 1;
    eprintln!(
        "[verify] {tag}: occlusionState=0x{occlusion:x} visible_bit={visible_bit} (1=on-screen-unoccluded)"
    );
}

/// 宿主 NSWindow：alloc + init，GPUIView 后续挂到其 contentView。
/// 返回 content_view 的裸指针（与 gpui `WindowOptions::embedded_in` 的 *mut c_void 对应）。
fn create_host_window() -> *mut c_void {
    let window_rect = NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(900.0, 700.0));
    let style_mask = NSWindowStyleMask::NSTitledWindowMask
        | NSWindowStyleMask::NSClosableWindowMask
        | NSWindowStyleMask::NSResizableWindowMask;

    unsafe {
        let _pool = NSAutoreleasePool::new(nil);
        let app = NSApplication::sharedApplication(nil);

        let window: id = msg_send![class!(NSWindow), alloc];
        let window: id = msg_send![
            window,
            initWithContentRect: window_rect
            styleMask: style_mask
            backing: NSBackingStoreBuffered
            defer: NO
        ];
        assert!(!window.is_null(), "host window 创建失败");
        HOST_WINDOW.store(window as usize, Ordering::SeqCst);

        let content_view: id = msg_send![window, contentView];
        let title = NSString::alloc(nil).init_str("OMP · Zomp P0 宿主窗口");
        let () = msg_send![window, setTitle: title];
        let () = msg_send![window, setReleasedWhenClosed: NO];
        // 无 bundle 的 CLI 进程 activation policy 默认不保证 Regular；显式设置，避免窗口不显示
        let () = msg_send![app, setActivationPolicy: 0]; // 0 = NSApplicationActivationPolicyRegular
        // 窗口加入所有 space（壳层验证需要：当前 space 可能被全屏 app 占用）
        let () = msg_send![window, setCollectionBehavior: 1 << 1]; // NSWindowCollectionBehaviorCanJoinAllSpaces
        let () = msg_send![window, makeKeyAndOrderFront: nil];
        let () = msg_send![app, activateIgnoringOtherApps: true];

        content_view as *mut c_void
    }
}

fn normal_main() {
    // 对照实验：不嵌入、普通 gpui 窗口（hello_world 等价路径）
    application().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(900.0), px(700.0)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |_window, cx| cx.new(|_| EmbeddedView::new()),
        )
        .expect("normal window 打开失败");
        cx.activate(true);
        eprintln!("[spike] normal open_window succeeded");
    });
}

fn main() {
    eprintln!("[spike] main start");
    if std::env::var("OMP_SPIKE_NORMAL").is_ok() {
        normal_main();
        return;
    }
    if std::env::var("OMP_SPIKE_BADORDER").is_ok() {
        // 约束 1 对照：宿主窗口在 application().run 之前创建（错误顺序）
        // 预期：gpui 初始化时 set_ivar 失败 panic “Ivar platform not found on class NSApplication”
        let _bad = create_host_window();
        eprintln!("[spike] BADORDER: host window created BEFORE application().run — panics expected");
    }
    application().run(move |cx: &mut App| {
        eprintln!("[spike] application().run callback entered");
        // 宿主窗口必须在 gpui 初始化后创建（gpui 先注册 GPUIApplication 子类承载 platform ivar
        // —— 若提前调 NSApplication::sharedApplication，会造出纯 NSApplication 实例导致 panic）
        let host_view = create_host_window();
        eprintln!("[spike] host window created, host_view={host_view:?}");

        let options = WindowOptions {
            embedded_in: Some(host_view),
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                Point::new(px(0.0), px(0.0)),
                size(px(900.0), px(700.0)),
            ))),
            titlebar: None,
            show: false, // 窗口由宿主管显示（宿主窗口已 makeKeyAndOrderFront）
            focus: false,
            ..Default::default()
        };
        cx.open_window(options, |_window, cx| cx.new(|_| EmbeddedView::new()))
            .expect("embedded window 打开失败");
        eprintln!("[spike] open_window succeeded");
        // 宿主窗口在 run loop 下一 tick 再 order（确保 launch 完成）；激活策略/所有 space 属壳层职责
        cx.defer(move |_| {
            unsafe {
                let app = NSApplication::sharedApplication(nil);
                let window = HOST_WINDOW.load(Ordering::SeqCst) as id;
                let () = msg_send![app, setActivationPolicy: 0];
                let () = msg_send![window, orderFrontRegardless];
                let () = msg_send![window, makeKeyWindow];
                let () = msg_send![app, activateIgnoringOtherApps: true];

                // 约束 2 对照：在 gpui update/defer 上下文内同步 sendEvent（错误注入方式）
                // 预期：MacWindowState 锁重入 → 死锁挂起（handle_view_event park 在 RawMutex.lock_slow）
                if std::env::var("OMP_SPIKE_SYNCSEND").is_ok() {
                    let (down, up) = make_click_events(window);
                    eprintln!("[spike] SYNCSEND: sending within defer (deadlock expected)");
                    let () = msg_send![window, sendEvent: down];
                    let () = msg_send![window, sendEvent: up];
                    eprintln!("[spike] SYNCSEND: returned (should never print)");
                }

                // 约束 3 验证：心跳观察遮挡/可见状态（配合外部 CPU 采样；窗口状态只由用户/系统决定）
                if std::env::var("OMP_SPIKE_VERIFY").is_ok() {
                    unsafe { print_occlusion("start") };
                    fn heartbeat(count: u32) {
                        if count == 0 {
                            return;
                        }
                        let q = dispatch2::Queue::main();
                        let _ = q.after(
                            dispatch2::DispatchTime::try_from(std::time::Duration::from_millis(3000))
                                .expect("time"),
                            move || {
                                unsafe { print_occlusion(&format!("hb{count}")) };
                                heartbeat(count - 1);
                            },
                        );
                    }
                    heartbeat(40);
                }

                // 自动点击验证（环境受限时启用）：不能直接 sendEvent（gpui 持锁会重入死锁），
                // 用 GCD 主队列延迟到下一轮 run loop 再注入
                if std::env::var("OMP_SPIKE_AUTOCLICK").is_ok() {
                    dispatch2::Queue::main()
                        .after(
                            dispatch2::DispatchTime::try_from(std::time::Duration::from_millis(800))
                                .expect("time"),
                            || {
                                unsafe {
                                    let window = HOST_WINDOW.load(Ordering::SeqCst) as id;
                                    let (down, up) = make_click_events(window);
                                    eprintln!("[spike] gcd-click: sending synthetic click");
                                    let () = msg_send![window, sendEvent: down];
                                    let () = msg_send![window, sendEvent: up];
                                }
                            },
                        )
                        .expect("dispatch click");
                    eprintln!("[spike] gcd-click scheduled");
                }
            }
        });
    });
    eprintln!("[spike] application().run returned (event loop ended)");
}