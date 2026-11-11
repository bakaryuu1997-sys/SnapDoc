use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Mọi thao tác GHI (đọc-sửa-ghi) đi qua khoá này: 2 cửa sổ cùng đổi cài đặt một lúc
/// (vd thanh chụp đổi "hẹn giờ" trong khi Cài đặt đang lưu) không còn ghi đè mất thay đổi của nhau.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn write_lock() -> std::sync::MutexGuard<'static, ()> {
    WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Ghi nguyên tử: ghi file tạm cạnh đó rồi đổi tên — mất điện/crash giữa chừng không để lại
/// `settings.json` cụt (nạp lại sẽ rơi về mặc định và mất hết cài đặt).
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Lỗi ghi settings: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Lỗi ghi settings: {e}")
    })
}

/// Kiểm tra KIỂU của các key đã biết. Key lạ vẫn được giữ nguyên (nhiều key do chính app ghi
/// như `lastRecordRegion`, `lastGifSaveAsDir`… — chặn theo danh sách cứng sẽ làm hỏng chúng).
pub fn validate(v: &Value) -> Result<(), String> {
    let obj = v.as_object().ok_or("Settings phải là một object")?;
    let is_str = |k: &str| obj.get(k).map(|x| x.is_string()).unwrap_or(true);
    let is_bool = |k: &str| obj.get(k).map(|x| x.is_boolean()).unwrap_or(true);
    let one_of = |k: &str, allowed: &[&str]| {
        obj.get(k).map(|x| x.as_str().map(|s| allowed.contains(&s)).unwrap_or(false)).unwrap_or(true)
    };
    for k in ["saveDir", "language", "lastImageSaveAsDir", "lastVideoSaveAsDir", "lastGifSaveAsDir"] {
        if !is_str(k) {
            return Err(format!("`{k}` phải là chuỗi"));
        }
    }
    for k in [
        "openEditorAfterCapture",
        "rememberLastRegion",
        "launchAtLogin",
        "recordSelf",
        "recordShowKeystrokes",
        "recordShowClicks",
    ] {
        if !is_bool(k) {
            return Err(format!("`{k}` phải là true/false"));
        }
    }
    if !one_of("format", &["png", "jpg", "webp"]) {
        return Err("`format` phải là png/jpg/webp".into());
    }
    if !one_of("defaultOutput", &["editor", "clipboard", "save", "save_copy", "copy_editor"]) {
        return Err("`defaultOutput` không hợp lệ".into());
    }
    if !one_of("recordAudioSource", &["off", "mic", "system", "both"]) {
        return Err("`recordAudioSource` không hợp lệ".into());
    }
    if let Some(t) = obj.get("timerSeconds") {
        if !t.as_u64().map(|n| n <= 60).unwrap_or(false) {
            return Err("`timerSeconds` phải là số 0–60".into());
        }
    }
    if let Some(sc) = obj.get("shortcuts") {
        let ok = sc.as_object().map(|m| m.values().all(|x| x.is_string())).unwrap_or(false);
        if !ok {
            return Err("`shortcuts` phải là object chứa chuỗi".into());
        }
    }
    Ok(())
}

/// Gộp `patch` vào bản MỚI NHẤT đang lưu rồi ghi nguyên tử; trả về settings sau khi gộp.
/// Chỉ các key có trong `patch` thay đổi (giá trị `null` = xoá key; `shortcuts` gộp từng phím).
pub fn patch(config_dir: &PathBuf, patch: &Value) -> Result<Value, String> {
    let patch_obj = patch.as_object().ok_or("Bản vá settings phải là một object")?;
    let _g = write_lock();
    let mut cur = load(config_dir);
    if !cur.is_object() {
        cur = defaults();
    }
    for (k, v) in patch_obj {
        if v.is_null() {
            cur.as_object_mut().map(|o| o.remove(k));
        } else if k == "shortcuts" && cur.get("shortcuts").map(|x| x.is_object()).unwrap_or(false) && v.is_object() {
            if let (Some(dst), Some(src)) = (cur["shortcuts"].as_object_mut(), v.as_object()) {
                for (sk, sv) in src {
                    dst.insert(sk.clone(), sv.clone());
                }
            }
        } else {
            cur[k] = v.clone();
        }
    }
    validate(&cur)?;
    std::fs::create_dir_all(config_dir).ok();
    let path = settings_path(config_dir);
    let content = serde_json::to_string_pretty(&cur).map_err(|e| format!("Lỗi serialize: {e}"))?;
    write_atomic(&path, content.as_bytes())?;
    if let Ok(mut guard) = cache().lock() {
        *guard = Some((path, cur.clone()));
    }
    Ok(cur)
}

fn settings_path(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("settings.json")
}

/// Cache RAM của settings.json — các hot path (MỖI lần nhấn hotkey qua
/// `hotkey::handle`, rebuild tray menu, bắt đầu quay/chụp...) đều gọi
/// `load()`; đọc + parse file đồng bộ từ đĩa mỗi lần là I/O thừa. Mọi thao
/// tác GHI đều đi qua `save()` của chính module này nên invalidate tại đó là
/// đủ; sửa file bằng tay từ ngoài khi app đang chạy không được hỗ trợ (cần
/// restart). Key theo path để test (mỗi test 1 thư mục riêng) không dẫm nhau.
static CACHE: OnceLock<Mutex<Option<(PathBuf, Value)>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<(PathBuf, Value)>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Giá trị mặc định khi chưa có file settings.
fn defaults() -> Value {
    json!({
        "saveDir": "",
        "format": "png",
        "defaultOutput": "editor",
        "openEditorAfterCapture": true,
        "timerSeconds": 0,
        "rememberLastRegion": false,
        "launchAtLogin": true,
        "recordAudioSource": "off",
        "recordSelf": false,
        "recordShowKeystrokes": false,
        "recordShowClicks": true,
        "language": "vi",
        "shortcuts": {
            "captureBar": "CmdOrCtrl+Shift+5",
            "full": "CmdOrCtrl+Shift+1",
            "region": "CmdOrCtrl+Shift+2",
            "window": "CmdOrCtrl+Shift+3",
            "all": "CmdOrCtrl+Shift+4",
            "captureCopy": "CmdOrCtrl+Shift+C",
            "scroll": "CmdOrCtrl+Shift+6",
            "record": "CmdOrCtrl+Shift+7"
        }
    })
}

/// File settings.json đã từng được lưu chưa — dùng để phát hiện "lần đầu
/// chạy sau khi cài" (xem `lib.rs`). KHÔNG dùng key trong giá trị trả về từ
/// `load()` để kiểm tra: `load()` tự fallback về `defaults()` khi file chưa
/// tồn tại, mà `defaults()` đã có sẵn mọi key (kể cả `launchAtLogin`) — kiểm
/// tra key sẽ luôn đúng dù file thật sự chưa từng được ghi.
pub fn exists(config_dir: &PathBuf) -> bool {
    settings_path(config_dir).exists()
}

pub fn load(config_dir: &PathBuf) -> Value {
    let path = settings_path(config_dir);
    if let Ok(guard) = cache().lock() {
        if let Some((cached_path, value)) = guard.as_ref() {
            if cached_path == &path {
                return value.clone();
            }
        }
    }
    let value = match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| defaults()),
        Err(_) => defaults(),
    };
    if let Ok(mut guard) = cache().lock() {
        *guard = Some((path, value.clone()));
    }
    value
}

pub fn save(config_dir: &PathBuf, value: &Value) -> Result<(), String> {
    validate(value)?;
    let _g = write_lock();
    std::fs::create_dir_all(config_dir).ok();
    let path = settings_path(config_dir);
    let content =
        serde_json::to_string_pretty(value).map_err(|e| format!("Lỗi serialize: {e}"))?;
    write_atomic(&path, content.as_bytes())?;
    if let Ok(mut guard) = cache().lock() {
        *guard = Some((path, value.clone()));
    }
    Ok(())
}

pub fn is_record_self(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    load(&config_dir)
        .get("recordSelf")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Xác nhận đúng bug đã sửa ở `lib.rs`: kiểm tra key trong `load()` LUÔN
    /// đúng (vì fallback về `defaults()` đã có sẵn key) dù file chưa từng
    /// được ghi — phải dùng `exists()` (kiểm tra file thật) mới phân biệt
    /// được "lần đầu chạy" với "đã từng lưu".
    #[test]
    fn exists_reflects_actual_file_presence_not_defaults() {
        let dir = std::env::temp_dir().join(format!("snapdoc-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        assert!(!exists(&dir), "chưa từng save() thì exists() phải là false");
        let loaded = load(&dir);
        assert!(loaded.get("launchAtLogin").is_some(), "load() fallback vẫn có key này");
        assert!(!exists(&dir), "load() không được tự tạo file trên đĩa");

        save(&dir, &loaded).unwrap();
        assert!(exists(&dir), "sau save() phải thấy file thật trên đĩa");

        std::fs::remove_dir_all(&dir).ok();
    }

    fn fresh_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("snapdoc-settings-{tag}-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn patch_changes_only_given_keys_and_keeps_unknown_ones() {
        let d = fresh_dir("patch");
        let mut base = load(&d);
        base["lastRecordRegion"] = json!({"x": 1});
        base["lastGifSaveAsDir"] = json!("D:/gif");
        save(&d, &base).unwrap();
        let merged = patch(&d, &json!({"timerSeconds": 5})).unwrap();
        assert_eq!(merged["timerSeconds"], 5);
        assert_eq!(merged["lastRecordRegion"]["x"], 1, "key lạ phải được giữ");
        assert_eq!(merged["lastGifSaveAsDir"], "D:/gif");
        assert_eq!(load(&d)["timerSeconds"], 5, "đã ghi xuống đĩa/cache");
        assert!(!d.join("settings.json.tmp").exists(), "không để lại file tạm");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn patch_merges_shortcuts_per_key() {
        let d = fresh_dir("shortcuts");
        patch(&d, &json!({"shortcuts": {"full": "CmdOrCtrl+Alt+1"}})).unwrap();
        let m = patch(&d, &json!({"shortcuts": {"region": "CmdOrCtrl+Alt+2"}})).unwrap();
        assert_eq!(m["shortcuts"]["full"], "CmdOrCtrl+Alt+1", "phím đã đổi trước đó không bị mất");
        assert_eq!(m["shortcuts"]["region"], "CmdOrCtrl+Alt+2");
        assert_eq!(m["shortcuts"]["scroll"], "CmdOrCtrl+Shift+6", "phím khác giữ mặc định");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn patch_rejects_bad_types_and_leaves_file_untouched() {
        let d = fresh_dir("reject");
        patch(&d, &json!({"timerSeconds": 5})).unwrap();
        assert!(patch(&d, &json!({"timerSeconds": 999})).is_err());
        assert!(patch(&d, &json!({"format": "bmp"})).is_err());
        assert!(patch(&d, &json!({"launchAtLogin": "yes"})).is_err());
        assert!(patch(&d, &json!({"recordAudioSource": "radio"})).is_err());
        assert!(patch(&d, &json!([1, 2])).is_err());
        assert_eq!(load(&d)["timerSeconds"], 5, "bản vá lỗi không được ghi gì");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn null_patch_removes_key() {
        let d = fresh_dir("null");
        patch(&d, &json!({"lastGifSaveAsDir": "D:/x"})).unwrap();
        let m = patch(&d, &json!({"lastGifSaveAsDir": null})).unwrap();
        assert!(m.get("lastGifSaveAsDir").is_none());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn concurrent_patches_do_not_lose_updates() {
        let d = fresh_dir("race");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let d = d.clone();
                std::thread::spawn(move || {
                    let mut m = serde_json::Map::new();
                    m.insert(format!("k{i}"), json!(i));
                    patch(&d, &Value::Object(m)).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let v = load(&d);
        for i in 0..8 {
            assert_eq!(v[format!("k{i}")], i, "mất cập nhật k{i}");
        }
        std::fs::remove_dir_all(&d).ok();
    }
}
