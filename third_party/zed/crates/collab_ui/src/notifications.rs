#[cfg(feature = "livekit")]
pub mod incoming_call_notification;
#[cfg(feature = "livekit")]
pub mod project_shared_notification;

use gpui::App;
use std::sync::Arc;
use workspace::AppState;

pub fn init(app_state: &Arc<AppState>, cx: &mut App) {
    #[cfg(feature = "livekit")]
    incoming_call_notification::init(app_state, cx);
    #[cfg(feature = "livekit")]
    project_shared_notification::init(app_state, cx);
}
