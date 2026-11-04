import { useTranslation } from "react-i18next";
import { ipc } from "../../lib/ipc";
import { showError } from "../../lib/notify";
import { useHistory } from "./useHistoryStore";

export default function HistoryEmptyState() {
  const { t } = useTranslation();
  const filter = useHistory((s) => s.filter);
  const setFilter = useHistory((s) => s.setFilter);

  const isTrash = !!filter.trashOnly;
  const hasCustomFilter = !!(filter.mediaType || filter.captureMode || filter.from || filter.to);

  const handleCaptureNow = () => {
    ipc.startQuick().catch((err) => showError(err));
  };

  const handleResetFilter = () => {
    setFilter({
      mediaType: undefined,
      captureMode: undefined,
      from: undefined,
      to: undefined,
    });
  };

  if (isTrash) {
    return (
      <div style={container}>
        <div style={iconCircle}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </div>
        <h3 style={title}>{t("history.trashEmptyTitle")}</h3>
        <p style={description}>{t("history.trashEmptyDesc")}</p>
      </div>
    );
  }

  if (hasCustomFilter) {
    return (
      <div style={container}>
        <div style={iconCircle}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </div>
        <h3 style={title}>{t("history.filterEmptyTitle")}</h3>
        <p style={description}>{t("history.filterEmptyDesc")}</p>
        <button style={actionBtn} onClick={handleResetFilter}>
          {t("history.clearFilterBtn")}
        </button>
      </div>
    );
  }

  return (
    <div style={container}>
      {/* Decorative Camera Icon with Sparkle */}
      <div style={pulseGlowWrap}>
        <div style={iconCirclePrimary}>
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
            <circle cx="12" cy="13" r="3.5" />
          </svg>
        </div>
      </div>

      <h3 style={title}>{t("history.emptyTitle")}</h3>
      <p style={description}>{t("history.emptyDesc")}</p>

      {/* Primary Action Button */}
      <button style={primaryBtn} onClick={handleCaptureNow}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
        <span>{t("history.captureNowBtn")}</span>
      </button>

      {/* Shortcut Reference Pills */}
      <div style={shortcutWrap}>
        <div style={shortcutCard}>
          <kbd style={kbd}>Ctrl+Shift+2</kbd>
          <span style={shortcutLabel}>{t("shortcuts.region")}</span>
        </div>
        <div style={shortcutCard}>
          <kbd style={kbd}>Ctrl+Shift+1</kbd>
          <span style={shortcutLabel}>{t("shortcuts.full")}</span>
        </div>
        <div style={shortcutCard}>
          <kbd style={kbd}>Ctrl+Shift+5</kbd>
          <span style={shortcutLabel}>{t("shortcuts.captureBar")}</span>
        </div>
      </div>
    </div>
  );
}

/* ── Styles ── */

const container: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "48px 24px",
  textAlign: "center",
  margin: "auto",
  maxWidth: 520,
};

const pulseGlowWrap: React.CSSProperties = {
  marginBottom: 20,
  position: "relative",
};

const iconCircle: React.CSSProperties = {
  width: 76,
  height: 76,
  borderRadius: "50%",
  background: "rgba(255, 255, 255, 0.05)",
  border: "1px solid rgba(255, 255, 255, 0.1)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  marginBottom: 16,
};

const iconCirclePrimary: React.CSSProperties = {
  width: 84,
  height: 84,
  borderRadius: "50%",
  background: "linear-gradient(135deg, rgba(59, 130, 246, 0.15) 0%, rgba(37, 99, 235, 0.05) 100%)",
  border: "1px solid rgba(96, 165, 250, 0.3)",
  boxShadow: "0 8px 32px rgba(59, 130, 246, 0.2)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const title: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: "var(--text)",
  margin: "0 0 8px 0",
};

const description: React.CSSProperties = {
  fontSize: 13,
  color: "var(--text-dim)",
  lineHeight: 1.5,
  margin: "0 0 24px 0",
  maxWidth: 420,
};

const primaryBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 20px",
  borderRadius: 8,
  background: "#3b82f6",
  color: "#ffffff",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  border: "none",
  boxShadow: "0 4px 14px rgba(59, 130, 246, 0.35)",
  transition: "background 0.12s, transform 0.12s",
  marginBottom: 32,
};

const actionBtn: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 6,
  background: "rgba(255, 255, 255, 0.08)",
  border: "1px solid rgba(255, 255, 255, 0.15)",
  color: "var(--text)",
  fontSize: 13,
  cursor: "pointer",
  transition: "background 0.12s",
};

const shortcutWrap: React.CSSProperties = {
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
  justifyContent: "center",
};

const shortcutCard: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  borderRadius: 6,
  background: "rgba(255, 255, 255, 0.04)",
  border: "1px solid rgba(255, 255, 255, 0.07)",
};

const kbd: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 11,
  fontWeight: 600,
  fontFamily: "inherit",
  background: "rgba(255, 255, 255, 0.12)",
  borderRadius: 4,
  color: "var(--text)",
};

const shortcutLabel: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-dim)",
};
