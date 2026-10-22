//! macOS window chrome. Plica draws its toolbar in the (transparent) title bar. When macOS shows its
//! own tab bar, it overlays the page, and in full screen the traffic lights go away; AppKit doesn't
//! tell a webview either, so this checks every window a few times a second (a couple of cheap AppKit
//! calls) and sends `window-chrome` to a window whenever its state changes. The page then moves its
//! toolbar below the tab bar, or drops the space it keeps for the traffic lights.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use objc2_app_kit::{NSWindow, NSWindowStyleMask};
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

#[derive(Serialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Chrome {
    /// Height (points) of system UI over the top of the page: title bar + tab bar; 0 without a tab bar.
    pub tab_bar_inset: f64,
    pub fullscreen: bool,
}

#[derive(Default)]
struct Seen(Mutex<HashMap<String, Chrome>>);

/// Inset to report: only when a tab bar is showing (the title bar alone is Plica's toolbar).
pub fn inset_for(tab_bar_visible: bool, window_height: f64, layout_top: f64) -> f64 {
    if tab_bar_visible {
        (window_height - layout_top).max(0.0).round()
    } else {
        0.0
    }
}

/// The page calls this once it listens for `window-chrome`: forget what this window was last told, so
/// the next check sends the current state (the first one may have gone out before the page loaded).
pub fn resend(app: &AppHandle, label: &str) {
    if let Some(seen) = app.try_state::<Seen>() {
        seen.0.lock().unwrap().remove(label);
    }
}

pub fn start(app: &AppHandle) {
    app.manage(Seen::default());
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(200));
        let handle = app.clone();
        if app.run_on_main_thread(move || check(&handle)).is_err() {
            return; // app is shutting down
        }
    });
}

fn check(app: &AppHandle) {
    let seen = app.state::<Seen>();
    let mut seen = seen.0.lock().unwrap();
    let windows = app.webview_windows();
    seen.retain(|label, _| windows.contains_key(label));
    for (label, window) in windows {
        let Ok(ptr) = window.ns_window() else { continue };
        // SAFETY: Tauri hands out the live NSWindow; we're on the main thread.
        let ns = unsafe { &*(ptr as *const NSWindow) };
        let visible = ns.tabGroup().is_some_and(|g| g.isTabBarVisible());
        let frame = ns.frame();
        let layout = ns.contentLayoutRect();
        let chrome = Chrome {
            tab_bar_inset: inset_for(visible, frame.size.height, layout.origin.y + layout.size.height),
            fullscreen: ns.styleMask().contains(NSWindowStyleMask::FullScreen),
        };
        if seen.get(&label) != Some(&chrome) {
            seen.insert(label.clone(), chrome);
            let _ = app.emit_to(EventTarget::webview_window(label), "window-chrome", chrome);
        }
    }
}

/// Put these windows into one native tab group, in this order, after `anchor` (a window whose tab group
/// they join), and bring the first of them forward. Windows created hidden appear as tabs.
pub fn group_as_tabs(app: &AppHandle, anchor: Option<&str>, labels: &[String]) {
    let windows: Vec<&NSWindow> = anchor
        .into_iter()
        .chain(labels.iter().map(String::as_str))
        .filter_map(|l| app.get_webview_window(l)?.ns_window().ok())
        // SAFETY: live NSWindows from Tauri; this runs on the main thread.
        .map(|ptr| unsafe { &*(ptr as *const NSWindow) })
        .collect();
    for pair in windows.windows(2) {
        // Each one right after the previous, so the tabs keep the batch order.
        pair[0].addTabbedWindow_ordered(pair[1], objc2_app_kit::NSWindowOrderingMode::Above);
    }
    let Some(first) = labels.first().and_then(|l| app.get_webview_window(l)) else { return };
    let _ = first.show();
    if let Ok(ptr) = first.ns_window() {
        // SAFETY: as above.
        let first = unsafe { &*(ptr as *const NSWindow) };
        if let Some(group) = first.tabGroup() {
            group.setSelectedWindow(Some(first));
        }
        first.makeKeyAndOrderFront(None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inset_only_counts_when_the_tab_bar_shows() {
        assert_eq!(inset_for(false, 780.0, 747.0), 0.0);
        assert_eq!(inset_for(true, 780.0, 720.6), 59.0);
        assert_eq!(inset_for(true, 780.0, 790.0), 0.0);
    }
}
