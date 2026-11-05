//! Chính sách an toàn của MCP — 3 lớp:
//!   1. Công tắc quyền GHI (`McpConfig.write_enabled`, mặc định TẮT): tool ghi/sửa/xoá bị từ chối.
//!   2. Nhật ký mọi lời gọi (xem `audit.rs`).
//!   3. Thao tác PHÁ HUỶ (xoá, ghi đè video gốc) luôn cần người dùng bấm xác nhận trong app
//!      (hộp thoại gốc của hệ điều hành) + giới hạn tốc độ cho mọi tool ghi.
//!
//! Tool KHÔNG tồn tại trên MCP (cố ý, không có đường vòng): xoá vĩnh viễn, dọn thùng rác,
//! sửa/xoá nhật ký, đổi Cài đặt, chụp/quay màn hình.

use serde_json::Value;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Read,
    Write,
    Destructive,
}

impl Class {
    pub fn label(self) -> &'static str {
        match self {
            Class::Read => "read",
            Class::Write => "write",
            Class::Destructive => "destructive",
        }
    }
}

pub const READ_TOOLS: &[&str] = &[
    "app_status",
    "list_history",
    "get_item",
    "get_preview",
    "get_captions",
    "captions_status",
    "get_job",
    "get_activity_log",
];

pub const WRITE_TOOLS: &[&str] = &[
    "import_video",
    "open_in_editor",
    "rename_item",
    "trim_video",
    "crop_video",
    "change_speed",
    "captions_setup",
    "generate_captions",
    "export_srt",
    "add_captions_to_video",
    "restore_item",
];

pub const DESTRUCTIVE_TOOLS: &[&str] = &["delete_to_trash"];

/// Phân loại một lời gọi. `trim_video` với `replaceOriginal: true` ghi đè file video gốc
/// nên được nâng lên mức PHÁ HUỶ. `None` = tool không tồn tại.
pub fn class_of(tool: &str, args: &Value) -> Option<Class> {
    if DESTRUCTIVE_TOOLS.contains(&tool) {
        return Some(Class::Destructive);
    }
    if tool == "trim_video" || tool == "crop_video" || tool == "change_speed" {
        if args.get("replaceOriginal").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Some(Class::Destructive);
        }
    }
    if WRITE_TOOLS.contains(&tool) {
        return Some(Class::Write);
    }
    if READ_TOOLS.contains(&tool) {
        return Some(Class::Read);
    }
    None
}

/// Lớp 1: công tắc quyền ghi.
pub fn gate(write_enabled: bool, class: Class) -> Result<(), String> {
    match class {
        Class::Read => Ok(()),
        Class::Write | Class::Destructive if write_enabled => Ok(()),
        _ => Err("Quyền GHI của AI agent đang TẮT (chế độ chỉ đọc). Người dùng cần mở SnapDoc → Cài đặt → AI Agent (MCP) và bật \"Cho phép agent ghi/sửa/xoá\" thì tool này mới chạy được. Hãy báo người dùng; không có cách nào khác để vượt qua.".to_string()),
    }
}

/// Cửa sổ trượt: tối đa `max` sự kiện trong `window`.
pub struct RateLimiter {
    events: VecDeque<Instant>,
    max: usize,
    window: Duration,
}

impl RateLimiter {
    pub fn new(max: usize, window: Duration) -> Self {
        Self { events: VecDeque::new(), max, window }
    }

    pub fn allow(&mut self, now: Instant) -> bool {
        while let Some(&front) = self.events.front() {
            if now.duration_since(front) >= self.window {
                self.events.pop_front();
            } else {
                break;
            }
        }
        if self.events.len() >= self.max {
            return false;
        }
        self.events.push_back(now);
        true
    }
}

pub const WRITE_PER_MIN: usize = 30;
pub const READ_PER_MIN: usize = 300;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_tools_pass_when_write_disabled() {
        for t in READ_TOOLS {
            let c = class_of(t, &json!({})).unwrap();
            assert_eq!(c, Class::Read, "{t}");
            assert!(gate(false, c).is_ok(), "{t} phải đọc được khi tắt quyền ghi");
        }
    }

    #[test]
    fn write_tools_are_denied_when_write_disabled_with_clear_message() {
        for t in WRITE_TOOLS.iter().chain(DESTRUCTIVE_TOOLS.iter()) {
            let c = class_of(t, &json!({})).unwrap();
            assert_ne!(c, Class::Read, "{t}");
            let err = gate(false, c).unwrap_err();
            assert!(err.contains("TẮT") && err.contains("Cài đặt"), "thông báo phải chỉ rõ cách bật: {err}");
            assert!(gate(true, c).is_ok(), "{t} chạy được khi đã bật");
        }
    }

    #[test]
    fn every_tool_is_classified_exactly_once() {
        let mut all: Vec<&str> = Vec::new();
        all.extend(READ_TOOLS);
        all.extend(WRITE_TOOLS);
        all.extend(DESTRUCTIVE_TOOLS);
        let mut sorted = all.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), all.len(), "tool bị khai ở 2 lớp");
    }

    #[test]
    fn unknown_tool_has_no_class_so_it_cannot_run() {
        assert_eq!(class_of("permanently_delete", &json!({})), None);
        assert_eq!(class_of("empty_trash", &json!({})), None);
        assert_eq!(class_of("set_settings", &json!({})), None);
        assert_eq!(class_of("clear_activity_log", &json!({})), None);
    }

    #[test]
    fn overwriting_original_is_destructive() {
        assert_eq!(class_of("trim_video", &json!({"replaceOriginal": true})), Some(Class::Destructive));
        assert_eq!(class_of("trim_video", &json!({"replaceOriginal": false})), Some(Class::Write));
        assert_eq!(class_of("trim_video", &json!({})), Some(Class::Write));
        // Giá trị không phải bool không được "lách" thành an toàn theo hướng ngược lại.
        assert_eq!(class_of("crop_video", &json!({"replaceOriginal": true})), Some(Class::Destructive));
        assert_eq!(class_of("delete_to_trash", &json!({})), Some(Class::Destructive));
    }

    #[test]
    fn rate_limiter_blocks_then_recovers() {
        let mut r = RateLimiter::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(r.allow(t0));
        assert!(r.allow(t0));
        assert!(r.allow(t0));
        assert!(!r.allow(t0), "lần thứ 4 trong cửa sổ bị chặn");
        assert!(!r.allow(t0 + Duration::from_secs(59)));
        assert!(r.allow(t0 + Duration::from_secs(61)), "hết cửa sổ thì cho tiếp");
    }
}
