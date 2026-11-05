//! Danh sách tool MCP (tên, mô tả, JSON Schema tham số). Mô tả viết bằng tiếng Anh
//! vì người đọc là mô hình AI; thông báo lỗi trả về cho người dùng thì tiếng Việt.

use serde_json::{json, Value};

const W: &str = " Requires the user to have enabled agent WRITE permission in SnapDoc settings; otherwise returns an error.";

fn tool(name: &str, title: &str, desc: &str, props: Value, required: &[&str], read_only: bool, destructive: bool) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": desc,
        "inputSchema": { "type": "object", "properties": props, "required": required, "additionalProperties": false },
        "annotations": { "readOnlyHint": read_only, "destructiveHint": destructive, "idempotentHint": read_only, "openWorldHint": false }
    })
}

fn id_prop() -> Value {
    json!({ "type": "string", "description": "Library item id (from list_history)." })
}

pub fn tool_defs() -> Vec<Value> {
    let crop = json!({
        "type": "object",
        "description": "Spatial crop in source-video pixels.",
        "properties": {
            "x": {"type":"integer","minimum":0}, "y": {"type":"integer","minimum":0},
            "width": {"type":"integer","minimum":2}, "height": {"type":"integer","minimum":2}
        },
        "required": ["x","y","width","height"]
    });
    let out_path = json!({ "type": "string", "description": "Optional absolute .mp4 output path. Must be inside SnapDoc's save folder, the source video's folder, or the user's Videos/Downloads/Desktop/Documents/Pictures folders, and must not already exist. Default: SnapDoc's save folder." });
    let replace = json!({ "type": "boolean", "default": false, "description": "DESTRUCTIVE: overwrite the original video file instead of creating a new item. Always asks the user for confirmation in the app; the original cannot be recovered." });

    vec![
        // ───────── read ─────────
        tool("app_status", "App status",
            "Get SnapDoc version, whether agent write permission is enabled, Library counts, subtitle (captions) engine state and running background jobs. Call this first.",
            json!({}), &[], true, false),
        tool("list_history", "List Library items",
            "List items in the SnapDoc Library (screenshots and recordings), newest first. Use trash=true to list the Trash.",
            json!({
                "mediaType": {"type":"string","enum":["image","video"]},
                "captureMode": {"type":"string","description":"e.g. region, window, full, record, imported"},
                "trash": {"type":"boolean","default":false},
                "limit": {"type":"integer","minimum":1,"maximum":100,"default":20},
                "offset": {"type":"integer","minimum":0,"default":0}
            }), &[], true, false),
        tool("get_item", "Get one item", "Get full metadata of one Library item (size, duration, file paths, edited flag...).",
            json!({"id": id_prop()}), &["id"], true, false),
        tool("get_preview", "Get preview image",
            "Return a preview image of an item: the rendered screenshot (downscaled to <=1600px) or the thumbnail of a video. Lets you actually look at the content.",
            json!({"id": id_prop()}), &["id"], true, false),
        tool("get_captions", "Get generated subtitles",
            "Return subtitles previously produced by generate_captions in this app session for an item (segments + SRT text).",
            json!({"id": id_prop()}), &["id"], true, false),
        tool("captions_status", "Subtitle engine status",
            "Whether the offline Whisper engine and models (base, small, turbo) are installed, and running caption jobs.",
            json!({}), &[], true, false),
        tool("get_job", "Get background job",
            "Fetch the state/result of a long-running job returned earlier as jobId. Optionally wait up to waitSeconds for it to finish.",
            json!({"jobId":{"type":"string"},"waitSeconds":{"type":"integer","minimum":0,"maximum":45,"default":0}}), &["jobId"], true, false),
        tool("get_activity_log", "Read activity log",
            "Read the log of what AI agents did through this MCP server (newest first). Read-only: agents cannot modify or delete the log.",
            json!({"limit":{"type":"integer","minimum":1,"maximum":200,"default":30}}), &[], true, false),
        // ───────── write ─────────
        tool("import_video", "Import a video",
            &format!("Add a video file from disk to the SnapDoc Library (the file stays where it is; .mkv/.avi are remuxed to mp4 next to the app data). Optionally open it in the Editor.{W}"),
            json!({
                "path": {"type":"string","description":"Absolute path to a .mp4/.mov/.m4v/.webm/.mkv/.avi file."},
                "openInEditor": {"type":"boolean","default":false}
            }), &["path"], false, false),
        tool("open_in_editor", "Open in Editor",
            &format!("Open a Library item (image or video) in the SnapDoc Editor window so the user can see it.{W}"),
            json!({"id": id_prop()}), &["id"], false, false),
        tool("rename_item", "Rename item",
            &format!("Set the display title of a Library item.{W}"),
            json!({"id": id_prop(), "title": {"type":"string","maxLength":200}}), &["id","title"], false, false),
        tool("trim_video", "Trim / cut / speed / crop video",
            &format!("Create an edited copy of a video: keep only the given time ranges (cut everything else), optionally change speed per range, drop audio, and crop. By default a NEW Library item is created and the original is untouched. Long edits may return a jobId; poll with get_job.{W}"),
            json!({
                "id": id_prop(),
                "keepRanges": {"type":"array","minItems":1,"description":"Ranges to KEEP in order, in milliseconds: [startMs, endMs] or [startMs, endMs, speed] (speed 0.25-8, default 1).",
                    "items": {"type":"array","items":{"type":"number"},"minItems":2,"maxItems":3}},
                "removeAudio": {"type":"boolean","default":false},
                "crop": crop,
                "outputPath": out_path,
                "replaceOriginal": replace
            }), &["id","keepRanges"], false, false),
        tool("crop_video", "Crop video",
            &format!("Crop the whole video to a rectangle (source pixels) and save as a new Library item.{W}"),
            json!({
                "id": id_prop(),
                "x": {"type":"integer","minimum":0}, "y": {"type":"integer","minimum":0},
                "width": {"type":"integer","minimum":2}, "height": {"type":"integer","minimum":2},
                "removeAudio": {"type":"boolean","default":false},
                "outputPath": out_path,
                "replaceOriginal": replace
            }), &["id","x","y","width","height"], false, false),
        tool("change_speed", "Change video speed",
            &format!("Speed up or slow down the whole video, or only the part between startMs and endMs, and save as a new Library item.{W}"),
            json!({
                "id": id_prop(),
                "speed": {"type":"number","minimum":0.25,"maximum":8},
                "startMs": {"type":"integer","minimum":0}, "endMs": {"type":"integer","minimum":1},
                "removeAudio": {"type":"boolean","default":false},
                "outputPath": out_path,
                "replaceOriginal": replace
            }), &["id","speed"], false, false),
        tool("captions_setup", "Download subtitle engine/models",
            &format!("Download the offline Whisper engine and models (base ~60 MB, small ~190 MB, turbo ~574 MB) from the internet in the background. Returns immediately; check captions_status.{W}"),
            json!({"models":{"type":"array","items":{"type":"string","enum":["base","small","turbo"]},"default":["base"]}}), &[], false, false),
        tool("generate_captions", "Generate subtitles",
            &format!("Transcribe the speech of a video with the offline Whisper engine (needs captions_setup first). Usually takes longer than a minute, so expect a jobId and poll get_job. Result is kept for export_srt / add_captions_to_video / get_captions.{W}"),
            json!({
                "id": id_prop(),
                "language": {"type":"string","default":"auto","description":"'auto' or an ISO code like vi, en, ja."},
                "model": {"type":"string","enum":["base","small","turbo"],"default":"base"},
                "saveSrt": {"type":"boolean","default":false,"description":"Also write <video name>.srt next to the video."}
            }), &["id"], false, false),
        tool("export_srt", "Export subtitles as .srt",
            &format!("Write the subtitles generated for an item to an .srt file (default: next to the video, never overwriting an existing file).{W}"),
            json!({"id": id_prop(), "outputPath": {"type":"string","description":"Optional absolute .srt path (same location rules as outputPath of trim_video)."}}), &["id"], false, false),
        tool("add_captions_to_video", "Add subtitles to video",
            &format!("Create a new video item with the generated subtitles embedded: mode 'soft' = switchable subtitle track (fast), 'burn' = hard-coded into the picture (re-encodes).{W}"),
            json!({
                "id": id_prop(),
                "mode": {"type":"string","enum":["soft","burn"],"default":"soft"},
                "outputPath": out_path
            }), &["id"], false, false),
        tool("restore_item", "Restore from Trash", &format!("Restore a Library item from the Trash.{W}"),
            json!({"id": id_prop()}), &["id"], false, false),
        // ───────── destructive ─────────
        tool("delete_to_trash", "Move item to Trash",
            &format!("Move a Library item to the Trash (recoverable for 30 days via restore_item). Always asks the user to confirm in the app, even when write permission is enabled. Permanent deletion is not available to agents.{W}"),
            json!({"id": id_prop()}), &["id"], false, true),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::policy::{DESTRUCTIVE_TOOLS, READ_TOOLS, WRITE_TOOLS};

    #[test]
    fn schema_and_policy_list_the_same_tools() {
        let mut from_schema: Vec<String> = tool_defs().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        let mut from_policy: Vec<String> = READ_TOOLS.iter().chain(WRITE_TOOLS).chain(DESTRUCTIVE_TOOLS).map(|s| s.to_string()).collect();
        from_schema.sort();
        from_policy.sort();
        assert_eq!(from_schema, from_policy, "mọi tool trong schema phải được phân loại ở policy và ngược lại");
    }

    #[test]
    fn hints_match_policy() {
        for t in tool_defs() {
            let name = t["name"].as_str().unwrap();
            let ro = t["annotations"]["readOnlyHint"].as_bool().unwrap();
            assert_eq!(ro, READ_TOOLS.contains(&name), "{name}");
            let d = t["annotations"]["destructiveHint"].as_bool().unwrap();
            assert_eq!(d, DESTRUCTIVE_TOOLS.contains(&name), "{name}");
            assert!(t["inputSchema"]["type"] == "object");
        }
    }
}
