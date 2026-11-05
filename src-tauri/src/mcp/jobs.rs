//! Kho tác vụ chạy lâu (cắt video, nhận diện phụ đề…). Lời gọi MCP chờ tối đa vài
//! chục giây; quá hạn thì trả về `jobId` để agent hỏi lại bằng tool `get_job` —
//! tránh vượt timeout của client MCP (thường ~60 giây).

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Job {
    pub id: String,
    pub tool: String,
    /// "running" | "done" | "error"
    pub status: &'static str,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub started: Instant,
}

impl Job {
    pub fn to_json(&self) -> Value {
        let mut v = serde_json::json!({
            "jobId": self.id,
            "tool": self.tool,
            "status": self.status,
            "elapsedSeconds": self.started.elapsed().as_secs(),
        });
        if let Some(r) = &self.result {
            v["result"] = r.clone();
        }
        if let Some(e) = &self.error {
            v["error"] = Value::String(e.clone());
        }
        v
    }
}

const MAX_KEPT: usize = 40;

#[derive(Default)]
pub struct JobStore {
    inner: Mutex<HashMap<String, Job>>,
    cv: Condvar,
}

impl JobStore {
    pub fn start(&self, tool: &str) -> String {
        let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        // Giữ số lượng có hạn: bỏ job đã xong cũ nhất.
        if g.len() >= MAX_KEPT {
            let oldest = g
                .values()
                .filter(|j| j.status != "running")
                .min_by_key(|j| j.started)
                .map(|j| j.id.clone());
            if let Some(o) = oldest {
                g.remove(&o);
            }
        }
        g.insert(
            id.clone(),
            Job { id: id.clone(), tool: tool.to_string(), status: "running", result: None, error: None, started: Instant::now() },
        );
        id
    }

    pub fn finish(&self, id: &str, r: Result<Value, String>) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(j) = g.get_mut(id) {
            match r {
                Ok(v) => {
                    j.status = "done";
                    j.result = Some(v);
                }
                Err(e) => {
                    j.status = "error";
                    j.error = Some(e);
                }
            }
        }
        self.cv.notify_all();
    }

    pub fn get(&self, id: &str) -> Option<Job> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
    }

    /// Chờ tới khi job xong hoặc hết `timeout`; trả về trạng thái mới nhất.
    pub fn wait(&self, id: &str, timeout: Duration) -> Option<Job> {
        let deadline = Instant::now() + timeout;
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            match g.get(id) {
                None => return None,
                Some(j) if j.status != "running" => return Some(j.clone()),
                Some(j) => {
                    let now = Instant::now();
                    if now >= deadline {
                        return Some(j.clone());
                    }
                    let (ng, _) = self.cv.wait_timeout(g, deadline - now).unwrap_or_else(|e| e.into_inner());
                    g = ng;
                }
            }
        }
    }
}

/// Chạy `f` ở thread riêng, chờ tối đa `wait`. Xong kịp → trả kết quả luôn; chưa xong → `jobId`.
pub fn run_with_wait(
    store: &Arc<JobStore>,
    tool: &str,
    wait: Duration,
    f: impl FnOnce() -> Result<Value, String> + Send + 'static,
) -> Result<Value, String> {
    let id = store.start(tool);
    let st = store.clone();
    let id2 = id.clone();
    let spawned = std::thread::Builder::new().name(format!("mcp-job-{tool}")).spawn(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
            .unwrap_or_else(|_| Err("Lỗi nội bộ khi chạy tác vụ.".to_string()));
        st.finish(&id2, r);
    });
    if let Err(e) = spawned {
        store.finish(&id, Err(format!("Không khởi chạy được tác vụ: {e}")));
    }
    match store.wait(&id, wait) {
        Some(j) if j.status == "done" => Ok(j.result.unwrap_or(Value::Null)),
        Some(j) if j.status == "error" => Err(j.error.unwrap_or_default()),
        Some(j) => Ok(serde_json::json!({
            "status": "running",
            "jobId": j.id,
            "message": "Tác vụ vẫn đang chạy. Gọi tool get_job với jobId này (có thể kèm waitSeconds) để lấy kết quả."
        })),
        None => Err("Tác vụ biến mất".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fast_job_returns_result_inline() {
        let s = Arc::new(JobStore::default());
        let r = run_with_wait(&s, "t", Duration::from_secs(5), || Ok(json!({"x": 1}))).unwrap();
        assert_eq!(r["x"], 1);
    }

    #[test]
    fn failing_job_returns_error() {
        let s = Arc::new(JobStore::default());
        let e = run_with_wait(&s, "t", Duration::from_secs(5), || Err("hỏng".to_string())).unwrap_err();
        assert_eq!(e, "hỏng");
    }

    #[test]
    fn slow_job_returns_job_id_then_completes() {
        let s = Arc::new(JobStore::default());
        let r = run_with_wait(&s, "slow", Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_millis(300));
            Ok(json!("done"))
        })
        .unwrap();
        assert_eq!(r["status"], "running");
        let id = r["jobId"].as_str().unwrap().to_string();
        let j = s.wait(&id, Duration::from_secs(5)).unwrap();
        assert_eq!(j.status, "done");
        assert_eq!(j.result.unwrap(), json!("done"));
    }

    #[test]
    fn panicking_job_becomes_error() {
        let s = Arc::new(JobStore::default());
        let e = run_with_wait(&s, "p", Duration::from_secs(5), || -> Result<Value, String> { panic!("boom") }).unwrap_err();
        assert!(e.contains("Lỗi nội bộ"));
    }
}
