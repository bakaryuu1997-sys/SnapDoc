import CommandPalette from "../../components/CommandPalette";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import HistoryToolbar from "./HistoryToolbar";
import HistoryGrid from "./HistoryGrid";
import HistoryList from "./HistoryList";
import HistoryPreviewPanel from "./HistoryPreviewPanel";
import { useHistory } from "./useHistoryStore";
import { ipc, type HistoryItem } from "../../lib/ipc";
import { showError } from "../../lib/notify";

export default function HistoryWindow() {
  const { t } = useTranslation();
  const reload = useHistory((s) => s.reload);
  const addItem = useHistory((s) => s.addItem);
  const viewMode = useHistory((s) => s.viewMode);
  const toast = useHistory((s) => s.toast);
  const hideToast = useHistory((s) => s.hideToast);

  useEffect(() => {
    reload();
  }, [reload]);

  // Auto-hide toast after 5s
  useEffect(() => {
    if (!toast?.visible) return;
    const timer = setTimeout(() => {
      hideToast();
    }, 5000);
    return () => clearTimeout(timer);
  }, [toast, hideToast]);

  const handleUndo = async () => {
    if (!toast || toast.ids.length === 0) return;
    const ids = toast.ids;
    hideToast();
    try {
      await ipc.restoreHistoryItems(ids);
      await reload();
    } catch (e) {
      showError(e);
    }
  };

  // Cắt video giờ xảy ra ngay trong Editor (webview RIÊNG với cửa sổ này) —
  // item mới cắt xong không thể `addItem` thẳng vào store ở đây được (mỗi
  // cửa sổ Tauri có JS heap/Zustand store độc lập), nên backend
  // (`history/commands.rs::trim_history_video`) emit event này để cửa sổ
  // History (đúng chỗ hiển thị danh sách) tự cập nhật.
  useEffect(() => {
    const unlisten = listen<HistoryItem>("history:item-added", (e) => addItem(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, [addItem]);

  const openEditor = async (id: string) => {
    try {
      await ipc.openHistoryItemInEditor(id);
    } catch (e) {
      showError(e);
    }
  };

  const busyRef = useRef(false);
  const openEditorRef = useRef(openEditor);
  openEditorRef.current = openEditor;
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      const st = useHistory.getState();
      const ids = st.selectedIds.length > 0 ? st.selectedIds : st.selectedId ? [st.selectedId] : [];
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        st.selectAll();
      } else if (e.key === "Escape") {
        if (ids.length > 0) st.clearSelection();
      } else if (e.key === "Enter" && !mod) {
        if (tag === "BUTTON" || ids.length !== 1) return;
        const item = st.items.find((it) => it.id === ids[0]);
        if (!item || item.deletedAt != null) return;
        e.preventDefault();
        openEditorRef.current(item.id);
      } else if ((e.key === "Delete" || e.key === "Backspace") && !mod) {
        if (ids.length === 0 || busyRef.current) return;
        e.preventDefault();
        const trash = !!st.filter.trashOnly;
        if (
          trash &&
          !confirm(
            ids.length === 1
              ? t("history.permanentDeleteConfirm")
              : t("history.permanentDeleteSelectedConfirm", { count: ids.length }),
          )
        ) return;
        busyRef.current = true;
        try {
          if (trash) {
            await ipc.permanentlyDeleteHistoryItems(ids);
            useHistory.getState().removeItems(ids);
          } else {
            await ipc.deleteHistoryItems(ids);
            useHistory.getState().removeItems(ids);
            useHistory.getState().showToast(t("history.deletedToast", { count: ids.length }), ids);
          }
        } catch (err) {
          showError(err);
        } finally {
          busyRef.current = false;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t]);

  return (
    <div className="solid-bg" style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      <HistoryToolbar />
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {viewMode === "grid" ? (
          <HistoryGrid onOpenEditor={openEditor} />
        ) : (
          <HistoryList onOpenEditor={openEditor} />
        )}
        <HistoryPreviewPanel onOpenEditor={openEditor} />
      </div>

      {/* Floating Undo Toast Banner */}
      {toast && toast.visible && (
        <div style={toastContainer}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16 }}>🗑️</span>
            <span style={{ fontSize: 13, color: "#f2f2f5", fontWeight: 500 }}>{toast.message}</span>
          </div>
          <button style={undoBtn} onClick={handleUndo}>
            ↺ {t("history.undo")}
          </button>
          <button style={toastCloseBtn} onClick={hideToast} title="Close">
            ✕
          </button>
        </div>
      )}
      <CommandPalette />
    </div>
  );
}

const toastContainer: React.CSSProperties = {
  position: "absolute",
  bottom: 24,
  left: "50%",
  transform: "translateX(-50%)",
  background: "rgba(30, 30, 36, 0.95)",
  border: "1px solid rgba(255, 255, 255, 0.15)",
  borderRadius: 10,
  padding: "10px 18px",
  display: "flex",
  alignItems: "center",
  gap: 16,
  boxShadow: "0 12px 36px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05)",
  zIndex: 9999,
};

const undoBtn: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  background: "rgba(59, 130, 246, 0.2)",
  border: "1px solid rgba(59, 130, 246, 0.4)",
  color: "#60a5fa",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  transition: "background 0.12s, color 0.12s",
};

const toastCloseBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text-dim)",
  cursor: "pointer",
  fontSize: 14,
  padding: 4,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
