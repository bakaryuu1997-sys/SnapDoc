import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { ipc, type McpAuditEntry, type McpInfo } from "../../lib/ipc";

/** Tab "AI Agent (MCP)": công tắc server, công tắc quyền GHI, cấu hình kết nối, nhật ký thao tác.
 * Backend: `src-tauri/src/mcp`. Mặc định server TẮT và quyền ghi TẮT. */
export default function McpTab() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [log, setLog] = useState<McpAuditEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(() => {
    ipc.mcpGetState().then(setInfo).catch((e) => setErr(String(e)));
    ipc.mcpAuditList(200).then(setLog).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const a = listen("mcp-changed", refresh);
    const b = listen("mcp-activity", () => ipc.mcpAuditList(200).then(setLog).catch(() => {}));
    return () => {
      a.then((f) => f());
      b.then((f) => f());
    };
  }, [refresh]);

  const run = async (fn: () => Promise<McpInfo>) => {
    setErr(null);
    try {
      setInfo(await fn());
    } catch (e) {
      setErr(String(e));
    }
  };

  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    }).catch(() => {});
  };

  if (!info) return <div style={dim}>{t("common.loading", "Đang tải…")}</div>;

  const tokenShown = showToken ? info.token : info.token.replace(/./g, "•").slice(0, 24);
  const q = (s: string) => JSON.stringify(s);
  const claudeCode = `claude mcp add --transport http snapdoc ${info.url} --header "Authorization: Bearer ${info.token}"`;
  const stdioJson = JSON.stringify(
    { mcpServers: { snapdoc: { command: info.exePath, args: ["--mcp-stdio"] } } },
    null,
    2,
  );
  const httpJson = JSON.stringify(
    { mcpServers: { snapdoc: { serverUrl: info.url, headers: { Authorization: `Bearer ${info.token}` } } } },
    null,
    2,
  );
  void q;

  return (
    <>
      <Card title={t("agent.title", "AI AGENT (MCP)")}>
        <div style={dim}>
          {t("agent.intro", "Cho phép Claude Code, Claude Desktop, Antigravity… kết nối với SnapDoc để đọc Thư viện và (nếu bạn cho phép) cắt/chỉnh video, tạo phụ đề. Chỉ nhận kết nối từ chính máy này (127.0.0.1) và phải có token.")}
        </div>
        <Row
          label={t("agent.enable", "Bật MCP server")}
          desc={info.running ? t("agent.runningAt", "Đang chạy tại {{url}}", { url: info.url }) : t("agent.off", "Đang tắt — không có cổng nào được mở.")}
        >
          <Switch checked={info.enabled} onChange={(v) => run(() => ipc.mcpSetEnabled(v))} testId="mcp-enable" />
        </Row>
        <Row
          label={t("agent.write", "Cho phép agent GHI / SỬA / XOÁ")}
          desc={info.writeEnabled
            ? t("agent.writeOn", "ĐANG BẬT — agent có thể nhập, cắt, đổi tên video, tạo phụ đề… Xoá và ghi đè bản gốc vẫn luôn hỏi bạn trong app.")
            : t("agent.writeOff", "TẮT (chỉ đọc) — mọi tool ghi bị từ chối. Khuyến nghị để tắt cho tới khi cần.")}
        >
          <Switch
            checked={info.writeEnabled}
            onChange={(v) => (v ? setConfirmWrite(true) : run(() => ipc.mcpSetWrite(false)))}
            testId="mcp-write"
          />
        </Row>
        {confirmWrite && (
          <div style={warnBox} data-testid="mcp-write-confirm">
            <b>{t("agent.confirmTitle", "Bật quyền ghi cho AI agent?")}</b>
            <div style={{ margin: "6px 0" }}>
              {t("agent.confirmBody", "Agent sẽ có thể thêm video vào Thư viện, tạo bản cắt/crop/đổi tốc độ, tạo file phụ đề và đổi tên mục. Mọi thao tác được ghi nhật ký bên dưới. Chuyển vào Thùng rác và ghi đè video gốc vẫn cần bạn bấm đồng ý mỗi lần. Xoá vĩnh viễn không có trên MCP.")}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={btnDanger} data-testid="mcp-write-confirm-yes" onClick={() => { setConfirmWrite(false); run(() => ipc.mcpSetWrite(true)); }}>
                {t("agent.confirmYes", "Bật quyền ghi")}
              </button>
              <button style={btn} onClick={() => setConfirmWrite(false)}>{t("common.cancel", "Huỷ")}</button>
            </div>
          </div>
        )}
        {err && <div style={errBox}>⚠ {err}</div>}
      </Card>

      {info.enabled && (
        <Card title={t("agent.connect", "KẾT NỐI")}>
          <div style={dim}>{t("agent.tokenLabel", "Token (giữ bí mật — ai có token là điều khiển được SnapDoc theo quyền ở trên)")}</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <code style={codeBox} data-testid="mcp-token">{tokenShown}</code>
            <button style={btn} onClick={() => setShowToken((v) => !v)}>{showToken ? t("agent.hide", "Ẩn") : t("agent.show", "Hiện")}</button>
            <button style={btn} onClick={() => copy("token", info.token)}>{copied === "token" ? "✓" : t("agent.copy", "Sao chép")}</button>
            <button style={btn} onClick={() => run(() => ipc.mcpRegenerateToken())}>{t("agent.regen", "Tạo token mới")}</button>
          </div>
          <Snippet title="Claude Code" text={claudeCode} k="cc" copied={copied} onCopy={copy} copyLabel={t("agent.copy", "Sao chép")} />
          <Snippet
            title={t("agent.desktopTitle", "Claude Desktop (claude_desktop_config.json) / Antigravity — qua cầu stdio")}
            text={stdioJson}
            k="stdio"
            copied={copied}
            onCopy={copy}
            copyLabel={t("agent.copy", "Sao chép")}
          />
          <Snippet
            title={t("agent.httpTitle", "Client hỗ trợ HTTP trực tiếp (vd Antigravity mcp_config.json)")}
            text={httpJson}
            k="http"
            copied={copied}
            onCopy={copy}
            copyLabel={t("agent.copy", "Sao chép")}
          />
        </Card>
      )}

      <Card title={t("agent.logTitle", "NHẬT KÝ THAO TÁC CỦA AGENT")}>
        <div style={dim}>
          {t("agent.logIntro", "Ghi mọi lời gọi của agent (kể cả bị từ chối). Agent chỉ đọc được nhật ký, không sửa/xoá được; chỉ bạn xoá được ở đây.")}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={btn} onClick={refresh}>↻ {t("agent.refresh", "Làm mới")}</button>
          {!confirmClear ? (
            <button style={btn} onClick={() => setConfirmClear(true)} disabled={log.length === 0}>{t("agent.clear", "Xoá nhật ký…")}</button>
          ) : (
            <>
              <button style={btnDanger} onClick={() => { setConfirmClear(false); ipc.mcpAuditClear().then(refresh); }}>{t("agent.clearYes", "Xoá hẳn")}</button>
              <button style={btn} onClick={() => setConfirmClear(false)}>{t("common.cancel", "Huỷ")}</button>
            </>
          )}
        </div>
        <div style={logWrap} data-testid="mcp-log">
          {log.length === 0 ? (
            <div style={dim}>{t("agent.logEmpty", "Chưa có hoạt động nào.")}</div>
          ) : (
            log.map((e, i) => (
              <div key={`${e.ts}-${i}`} style={logRow} data-outcome={e.outcome}>
                <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{new Date(e.ts).toLocaleString()}</span>
                <span style={{ ...badge, background: OUTCOME_BG[e.outcome] ?? "#64748b" }}>{e.outcome}</span>
                <span style={{ ...badge, background: KIND_BG[e.kind] ?? "#64748b" }}>{e.kind}</span>
                <b>{e.tool}</b>
                <span style={{ color: "var(--text-dim)", wordBreak: "break-all" }}>
                  {e.client ? `[${e.client}] ` : ""}{e.args}{e.detail ? ` → ${e.detail}` : ""}{e.durationMs ? ` (${e.durationMs} ms)` : ""}
                </span>
              </div>
            ))
          )}
        </div>
      </Card>
    </>
  );
}

const OUTCOME_BG: Record<string, string> = { ok: "#16a34a", error: "#dc2626", denied: "#d97706", running: "#2563eb" };
const KIND_BG: Record<string, string> = { read: "#475569", write: "#7c3aed", destructive: "#be123c", system: "#0e7490" };

function Snippet({ title, text, k, copied, onCopy, copyLabel }: { title: string; text: string; k: string; copied: string | null; onCopy: (k: string, t: string) => void; copyLabel: string }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
        <button style={btn} onClick={() => onCopy(k, text)}>{copied === k ? "✓" : copyLabel}</button>
      </div>
      <pre style={pre}>{text}</pre>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={card}>
      <div style={cardTitle}>{title}</div>
      <div style={cardBody}>{children}</div>
    </div>
  );
}

function Row({ label, desc, children }: { label: string; desc: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <div>
        <div style={{ fontSize: 13 }}>{label}</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{desc}</div>
      </div>
      {children}
    </div>
  );
}

function Switch({ checked, onChange, testId }: { checked: boolean; onChange: (v: boolean) => void; testId: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      style={{
        width: 40, height: 22, borderRadius: 11, border: "none", padding: 0, position: "relative", flexShrink: 0, cursor: "pointer",
        background: checked ? "var(--accent, #6366f1)" : "var(--border, rgba(255,255,255,0.15))",
      }}
    >
      <span style={{ position: "absolute", top: 3, left: checked ? 21 : 3, width: 16, height: 16, borderRadius: 8, background: "#fff", transition: "left 0.2s" }} />
    </button>
  );
}

const dim: React.CSSProperties = { fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6 };
const card: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", flexShrink: 0 };
const cardTitle: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-dim)", padding: "8px 12px 6px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)" };
const cardBody: React.CSSProperties = { padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10 };
const btn: React.CSSProperties = { padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-elevated)", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" };
const btnDanger: React.CSSProperties = { ...btn, background: "#b91c1c", color: "#fff", borderColor: "#b91c1c" };
const warnBox: React.CSSProperties = { padding: "10px 12px", borderRadius: 6, fontSize: 12, background: "#f59e0b18", border: "1px solid #f59e0b55", lineHeight: 1.5 };
const errBox: React.CSSProperties = { padding: "7px 12px", borderRadius: 6, fontSize: 12, color: "var(--danger)", background: "#ef444415", border: "1px solid #ef444430" };
const codeBox: React.CSSProperties = { flex: 1, padding: "5px 8px", borderRadius: 6, background: "var(--bg-elevated)", border: "1px solid var(--border)", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const pre: React.CSSProperties = { margin: 0, padding: 8, borderRadius: 6, background: "var(--bg-elevated)", border: "1px solid var(--border)", fontSize: 11, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" };
const logWrap: React.CSSProperties = { maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 6, display: "flex", flexDirection: "column", gap: 4 };
const logRow: React.CSSProperties = { display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap", fontSize: 11.5, borderBottom: "1px solid var(--border)", paddingBottom: 3 };
const badge: React.CSSProperties = { color: "#fff", fontSize: 10, borderRadius: 4, padding: "1px 5px", flexShrink: 0 };
