import React, { useEffect, useMemo, useRef, useState } from "react";
import { ipc, type OcrWord, type OcrLine } from "../../../lib/ipc";

export interface LiveTextOverlayProps {
  words: OcrWord[];
  lines?: OcrLine[];
  scale: number;
  offsetX: number;
  offsetY: number;
  imgW: number;
  imgH: number;
  enabled: boolean;
  engine?: "viesvtr" | "tesseract" | "windows";
  engineError?: string;
  onCopyText?: (text: string) => void;
  onRedactWords?: (words: OcrWord[]) => void;
  onFlash?: (msg: string) => void;
  onClose?: () => void;
  onOpenInspector?: () => void;
}

interface SelectionPopupState {
  text: string;
  x: number;
  y: number;
  words: OcrWord[];
}

export interface RenderLine {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  columnId?: number;
  words: { word: OcrWord; index: number }[];
}

export interface RenderColumn {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: RenderLine[];
}

/**
 * Phân chia các dòng vào từng Cột / Khung riêng biệt (Multi-Column Isolation).
 * Nhờ cấu trúc tách biệt DOM giữa Sidebar và Vùng làm việc chính / Bảng tính,
 * khi bôi đen chuột ở cột này sẽ tuyệt đối KHÔNG bị quét nhầm sang cột bên cạnh.
 */
export function groupLinesIntoColumns(lines: RenderLine[]): RenderColumn[] {
  if (!lines || lines.length === 0) return [];

  const colMap = new Map<number, RenderLine[]>();
  for (const line of lines) {
    const cId = line.columnId ?? 0;
    if (!colMap.has(cId)) colMap.set(cId, []);
    colMap.get(cId)!.push(line);
  }

  // Nếu tất cả các dòng đều cùng 1 columnId nhưng có >= 4 dòng,
  // quét phân cụm lề trái (X-clustering) để tự động phát hiện phân tách giữa Sidebar và Main Content:
  if (colMap.size === 1 && lines.length >= 4) {
    const nonSpanning = lines.filter((l) => l.w < 500);
    if (nonSpanning.length >= 4) {
      const minX = Math.min(...nonSpanning.map((l) => l.x));
      const maxX = Math.max(...nonSpanning.map((l) => l.x + l.w));
      const span = maxX - minX;

      let bestSplitX = -1;
      let maxGap = 0;

      for (let pct = 0.15; pct <= 0.65; pct += 0.05) {
        const splitCandidate = minX + span * pct;
        const leftLines = nonSpanning.filter((l) => l.x + l.w <= splitCandidate + 10);
        const rightLines = nonSpanning.filter((l) => l.x >= splitCandidate - 10);

        if (leftLines.length >= 2 && rightLines.length >= 2 && leftLines.length + rightLines.length >= nonSpanning.length * 0.75) {
          const maxLeft = Math.max(...leftLines.map((l) => l.x + l.w));
          const minRight = Math.min(...rightLines.map((l) => l.x));
          const gap = minRight - maxLeft;
          if (gap >= 12 && gap > maxGap) {
            maxGap = gap;
            bestSplitX = (maxLeft + minRight) / 2;
          }
        }
      }

      if (bestSplitX > 0) {
        colMap.clear();
        for (const line of lines) {
          const cId = (line.x + line.w / 2 > bestSplitX && line.x > bestSplitX - 15) ? 1 : 0;
          line.columnId = cId;
          if (!colMap.has(cId)) colMap.set(cId, []);
          colMap.get(cId)!.push(line);
        }
      }
    }
  }

  const cols: RenderColumn[] = [];
  colMap.forEach((colLines, cId) => {
    colLines.sort((a, b) => a.y - b.y);
    const minX = Math.min(...colLines.map((l) => l.x));
    const minY = Math.min(...colLines.map((l) => l.y));
    const maxX = Math.max(...colLines.map((l) => l.x + l.w));
    const maxY = Math.max(...colLines.map((l) => l.y + l.h));

    cols.push({
      id: `col-${cId}`,
      x: minX,
      y: minY,
      w: Math.max(maxX - minX, 10),
      h: Math.max(maxY - minY, 10),
      lines: colLines,
    });
  });

  return cols;
}

/**
 * Gom các từ thành từng dòng nếu chưa có lines từ DBNet (fallback dự phòng)
 * Hỗ trợ nhận diện cột (Sidebar vs Main Content) và gom liền mạch toàn bộ các từ trong dòng.
 */
export function groupWordsIntoLinesFallback(words: OcrWord[]): RenderLine[] {
  if (!words || words.length === 0) return [];

  // 1. Phân nhóm các từ theo rãnh dọc (Columns/Clusters) nếu có
  const colSplits: number[] = [];
  const minX = Math.min(...words.map((w) => w.x));
  const maxX = Math.max(...words.map((w) => w.x + w.w));
  const span = maxX - minX;

  if (span > 300 && words.length >= 6) {
    for (let pct = 0.15; pct <= 0.65; pct += 0.05) {
      const splitCandidate = minX + span * pct;
      const leftWords = words.filter((w) => w.x + w.w <= splitCandidate + 10);
      const rightWords = words.filter((w) => w.x >= splitCandidate - 10);
      if (leftWords.length >= 3 && rightWords.length >= 3 && leftWords.length + rightWords.length >= words.length * 0.85) {
        // Cả 2 cột phải có văn bản trải dài qua ít nhất 2 dòng Y khác nhau (tránh nhận nhầm khoảng trống thụt lề code)
        const leftYSet = new Set(leftWords.map((w) => Math.round(w.y / 14)));
        const rightYSet = new Set(rightWords.map((w) => Math.round(w.y / 14)));

        if (leftYSet.size >= 2 && rightYSet.size >= 2) {
          const maxLeft = Math.max(...leftWords.map((w) => w.x + w.w));
          const minRight = Math.min(...rightWords.map((w) => w.x));
          const gap = minRight - maxLeft;
          if (gap >= 20) {
            colSplits.push(Math.round((maxLeft + minRight) / 2));
            break;
          }
        }
      }
    }
  }

  const getColId = (w: OcrWord) => {
    if (colSplits.length === 0) return 0;
    if (w.x < colSplits[0] && w.x + w.w > colSplits[0] + 50) return 0;
    return w.x >= colSplits[0] ? 1 : 0;
  };

  const colBuckets = new Map<number, { word: OcrWord; index: number }[]>();
  words.forEach((w, idx) => {
    const cId = getColId(w);
    if (!colBuckets.has(cId)) colBuckets.set(cId, []);
    colBuckets.get(cId)!.push({ word: w, index: idx });
  });

  const res: RenderLine[] = [];

  colBuckets.forEach((colItems, cId) => {
    // Sắp xếp các từ trong cột theo Y trước, sau đó theo X
    colItems.sort((a, b) => {
      const yDiff = a.word.y - b.word.y;
      const minH = Math.min(a.word.h, b.word.h);
      if (Math.abs(yDiff) > minH * 0.55) return yDiff;
      return a.word.x - b.word.x;
    });

    let currentLine: { word: OcrWord; index: number }[] = [];
    let currentLineY = -1;
    let currentLineH = 0;

    for (const item of colItems) {
      if (currentLine.length === 0) {
        currentLine = [item];
        currentLineY = item.word.y;
        currentLineH = item.word.h;
      } else {
        const avgH = (currentLineH + item.word.h) / 2;
        const isSameY = Math.abs(item.word.y - currentLineY) <= avgH * 0.65;
        if (isSameY) {
          currentLine.push(item);
          currentLineY = Math.min(currentLineY, item.word.y);
          currentLineH = Math.max(currentLineH, item.word.h);
        } else {
          currentLine.sort((a, b) => a.word.x - b.word.x);
          const lMinX = Math.min(...currentLine.map((i) => i.word.x));
          const lMinY = Math.min(...currentLine.map((i) => i.word.y));
          const lMaxX = Math.max(...currentLine.map((i) => i.word.x + i.word.w));
          const lMaxY = Math.max(...currentLine.map((i) => i.word.y + i.word.h));
          res.push({
            id: `line-${res.length}`,
            x: lMinX,
            y: lMinY,
            w: Math.max(lMaxX - lMinX, 10),
            h: Math.max(lMaxY - lMinY, 12),
            columnId: cId,
            words: currentLine,
          });
          currentLine = [item];
          currentLineY = item.word.y;
          currentLineH = item.word.h;
        }
      }
    }

    if (currentLine.length > 0) {
      currentLine.sort((a, b) => a.word.x - b.word.x);
      const lMinX = Math.min(...currentLine.map((i) => i.word.x));
      const lMinY = Math.min(...currentLine.map((i) => i.word.y));
      const lMaxX = Math.max(...currentLine.map((i) => i.word.x + i.word.w));
      const lMaxY = Math.max(...currentLine.map((i) => i.word.y + i.word.h));
      res.push({
        id: `line-${res.length}`,
        x: lMinX,
        y: lMinY,
        w: Math.max(lMaxX - lMinX, 10),
        h: Math.max(lMaxY - lMinY, 12),
        columnId: cId,
        words: currentLine,
      });
    }
  });

  return res;
}

/**
 * Định dạng danh sách từ đã chọn thành văn bản có khoảng trắng chuẩn và xuống dòng đúng vị trí.
 * Đảm bảo 100% bôi đen bao nhiêu dòng thì copy ra đúng bấy nhiêu dòng (giữ nguyên cấu trúc văn bản).
 */
export function formatWordsToText(selectedWords: OcrWord[], lines?: RenderLine[]): string {
  if (!selectedWords || selectedWords.length === 0) return "";
  if (selectedWords.length === 1) return selectedWords[0].text;

  // Nếu có danh sách lines từ DBNet: ánh xạ trực tiếp theo cấu trúc dòng hiển thị
  if (lines && lines.length > 0) {
    const selectedSet = new Set(selectedWords);
    const outLines: string[] = [];

    for (const line of lines) {
      const matching = line.words
        .map((item) => item.word)
        .filter((w) =>
          selectedSet.has(w) ||
          selectedWords.some((sw) => sw.text === w.text && Math.abs(sw.x - w.x) <= 4 && Math.abs(sw.y - w.y) <= 4)
        );

      if (matching.length > 0) {
        matching.sort((a, b) => a.x - b.x);
        outLines.push(matching.map((w) => w.text).join(" "));
      }
    }

    if (outLines.length > 0) {
      return outLines.join("\n");
    }
  }

  // Fallback nếu không có lines
  const sorted = [...selectedWords].sort((a, b) => {
    const yDiff = a.y - b.y;
    const avgH = (a.h + b.h) / 2;
    if (Math.abs(yDiff) > avgH * 0.5) {
      return yDiff;
    }
    return a.x - b.x;
  });

  const fallbackLines: string[] = [];
  let currentLineWords: string[] = [sorted[0].text];
  let lastWord = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const avgH = (curr.h + lastWord.h) / 2;
    const isSameY = Math.abs(curr.y - lastWord.y) <= avgH * 0.55;
    const xGap = curr.x - (lastWord.x + lastWord.w);
    const isAdjacent = xGap >= -10 && xGap <= Math.max(60, avgH * 3.0);

    if (isSameY && isAdjacent) {
      currentLineWords.push(curr.text);
    } else {
      fallbackLines.push(currentLineWords.join(" "));
      currentLineWords = [curr.text];
    }
    lastWord = curr;
  }

  if (currentLineWords.length > 0) {
    fallbackLines.push(currentLineWords.join(" "));
  }

  return fallbackLines.join("\n");
}

function getWordsInSelection(container: HTMLElement, allWords: OcrWord[], sel: Selection): OcrWord[] {
  if (!sel || sel.isCollapsed) return [];
  const selected: OcrWord[] = [];
  const spans = container.querySelectorAll<HTMLSpanElement>(".snapdoc-live-text-word");
  spans.forEach((span) => {
    try {
      if (sel.containsNode(span, true)) {
        const idx = parseInt(span.getAttribute("data-index") || "-1", 10);
        const spanText = span.getAttribute("data-word-text") || span.textContent?.trim();
        const spanX = parseFloat(span.getAttribute("data-word-x") || "0");
        const spanY = parseFloat(span.getAttribute("data-word-y") || "0");

        if (idx >= 0 && allWords[idx] && allWords[idx].text === spanText) {
          selected.push(allWords[idx]);
        } else {
          // Fallback tìm chính xác theo text và tọa độ
          const found = allWords.find((w) => w.text === spanText && Math.abs(w.x - spanX) <= 4 && Math.abs(w.y - spanY) <= 4);
          if (found) {
            selected.push(found);
          } else if (idx >= 0 && allWords[idx]) {
            selected.push(allWords[idx]);
          }
        }
      }
    } catch {}
  });
  return selected;
}

export default function LiveTextOverlay({
  words,
  lines,
  scale,
  offsetX,
  offsetY,
  imgW,
  imgH,
  enabled,
  engine,
  engineError,
  onCopyText,
  onRedactWords,
  onFlash,
  onClose,
  onOpenInspector,
}: LiveTextOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<SelectionPopupState | null>(null);
  const [copiedPopup, setCopiedPopup] = useState(false);

  // Marquee / Box Selection: Kéo hộp chữ nhật tự do để chọn vùng chữ bất kỳ
  const [boxSelectMode, setBoxSelectMode] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [marqueeWords, setMarqueeWords] = useState<OcrWord[]>([]);
  const isDraggingMarquee = useRef(false);
  const marqueeStartRef = useRef<{ clientX: number; clientY: number } | null>(null);

  // Tạo danh sách các dòng hiển thị chính xác theo DBNet bounding boxes
  const renderLines = useMemo<RenderLine[]>(() => {
    if (lines && lines.length > 0) {
      return lines.map((l, lIdx) => {
        const sortedWords = [...(l.words || [])].sort((a, b) => a.x - b.x);
        return {
          id: `line-${lIdx}`,
          x: l.x,
          y: l.y,
          w: l.w,
          h: l.h,
          columnId: l.columnId ?? 0,
          words: sortedWords.map((w) => {
            let originalIdx = words.indexOf(w);
            if (originalIdx < 0) {
              originalIdx = words.findIndex((item) => item.text === w.text && Math.abs(item.x - w.x) <= 4 && Math.abs(item.y - w.y) <= 4);
            }
            return {
              word: w,
              index: originalIdx,
            };
          }),
        };
      });
    }
    return groupWordsIntoLinesFallback(words);
  }, [lines, words]);

  // Phân chia các dòng vào từng Cột / Khung độc lập để cô lập DOM triệt để
  const columns = useMemo<RenderColumn[]>(() => {
    return groupLinesIntoColumns(renderLines);
  }, [renderLines]);

  // Copy keyboard shortcut (Ctrl+C / Cmd+C) khi đang chọn text hoặc kéo marquee
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        let txt = "";
        if (popup && popup.text) {
          txt = popup.words.length > 0 ? formatWordsToText(popup.words, renderLines) : popup.text;
        } else if (marqueeWords.length > 0) {
          txt = formatWordsToText(marqueeWords, renderLines);
        } else {
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && containerRef.current?.contains(sel.anchorNode)) {
            const selectedWords = getWordsInSelection(containerRef.current, words, sel);
            txt = selectedWords.length > 0 ? formatWordsToText(selectedWords, renderLines) : sel.toString().trim();
          }
        }

        if (txt) {
          e.preventDefault();
          ipc.copyText(txt).catch(() => {});
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(txt).catch(() => {});
          }
          onCopyText?.(txt);
          onFlash?.(`Đã sao chép: "${txt.slice(0, 35)}${txt.length > 35 ? "..." : ""}" 📑`);
          setCopiedPopup(true);
          setTimeout(() => setCopiedPopup(false), 1500);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, words, renderLines, onCopyText, onFlash, popup, marqueeWords]);

  // Bắt sự kiện copy trình duyệt để luôn chèn đủ khoảng trắng và xuống dòng chuẩn
  useEffect(() => {
    if (!enabled) return;
    const handleCopyEvent = (e: ClipboardEvent) => {
      let txt = "";
      if (popup && popup.text) {
        txt = popup.words.length > 0 ? formatWordsToText(popup.words, renderLines) : popup.text;
      } else if (marqueeWords.length > 0) {
        txt = formatWordsToText(marqueeWords, renderLines);
      } else {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && containerRef.current?.contains(sel.anchorNode)) {
          const selectedWords = getWordsInSelection(containerRef.current, words, sel);
          txt = selectedWords.length > 0 ? formatWordsToText(selectedWords, renderLines) : sel.toString().trim();
        }
      }

      if (txt) {
        e.preventDefault();
        e.clipboardData?.setData("text/plain", txt);
        ipc.copyText(txt).catch(() => {});
        onFlash?.(`Đã sao chép: "${txt.slice(0, 35)}${txt.length > 35 ? "..." : ""}" 📑`);
        setCopiedPopup(true);
        setTimeout(() => setCopiedPopup(false), 1500);
      }
    };
    document.addEventListener("copy", handleCopyEvent);
    return () => document.removeEventListener("copy", handleCopyEvent);
  }, [enabled, words, renderLines, onFlash, popup, marqueeWords]);

  // Xử lý Escape để đóng popup hoặc tắt Live Text
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (popup) {
          setPopup(null);
          setMarqueeRect(null);
          setMarqueeWords([]);
          window.getSelection()?.removeAllRanges();
        } else {
          onClose?.();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, popup, onClose]);

  // Xử lý chuột nhả ra (mouseup) để bắt vùng chọn text
  const handleMouseUp = (_e?: React.MouseEvent) => {
    if (!enabled) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setPopup(null);
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const selectedWords = getWordsInSelection(container, words, sel);
    const text = selectedWords.length > 0 ? formatWordsToText(selectedWords, renderLines) : sel.toString().trim();
    if (!text || text.length === 0) {
      setPopup(null);
      return;
    }

    try {
      const range = sel.getRangeAt(0);
      const selRect = range.getBoundingClientRect();
      const contRect = container.getBoundingClientRect();

      // Tọa độ popup nổi phía trên đoạn bôi đen
      const px = Math.max(10, Math.min(contRect.width - 180, selRect.left + selRect.width / 2 - contRect.left - 80));
      const py = Math.max(8, selRect.top - contRect.top - 46);

      setPopup({
        text,
        x: px,
        y: py,
        words: selectedWords.length > 0 ? selectedWords : [],
      });
    } catch {
      setPopup(null);
    }
  };

  const handleCopy = async (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!popup) return;
    const textToCopy = popup.words.length > 0 ? formatWordsToText(popup.words, renderLines) : popup.text;
    if (!textToCopy) return;

    // Đảm bảo nạp vào Clipboard qua cả Tauri IPC, Browser API và fallback execCommand
    try {
      await ipc.copyText(textToCopy);
    } catch {}
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(textToCopy);
      }
    } catch {}
    try {
      const el = document.createElement("textarea");
      el.value = textToCopy;
      el.setAttribute("readonly", "");
      el.style.position = "absolute";
      el.style.left = "-9999px";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    } catch {}

    onCopyText?.(textToCopy);
    onFlash?.(`Đã sao chép: "${textToCopy.slice(0, 35)}${textToCopy.length > 35 ? "..." : ""}" 📑`);
    setCopiedPopup(true);
    setTimeout(() => {
      setCopiedPopup(false);
      setPopup(null);
      setMarqueeRect(null);
      setMarqueeWords([]);
    }, 1200);
  };

  const handleCopyAll = async () => {
    const allText = formatWordsToText(words, renderLines);
    if (!allText) return;
    try {
      await ipc.copyText(allText);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(allText);
      }
      onFlash?.(`Đã sao chép toàn bộ ${words.length} từ vào Clipboard! 📑`);
    } catch {
      onFlash?.("Không thể sao chép văn bản");
    }
  };

  const handleContainerMouseDown = (e: React.MouseEvent) => {
    if (
      (e.target as HTMLElement).closest(".snapdoc-live-text-popup") ||
      (e.target as HTMLElement).closest(".snapdoc-live-text-topbar")
    ) {
      return;
    }

    if (popup) {
      setPopup(null);
      setMarqueeRect(null);
      setMarqueeWords([]);
    }

    if (!boxSelectMode) return;

    // Bắt đầu kéo khung chọn marquee chữ nhật
    e.preventDefault();
    isDraggingMarquee.current = true;
    marqueeStartRef.current = { clientX: e.clientX, clientY: e.clientY };
    setMarqueeWords([]);
    setMarqueeRect(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleContainerMouseMove = (e: React.MouseEvent) => {
    if (!boxSelectMode || !isDraggingMarquee.current || !marqueeStartRef.current || !containerRef.current) return;
    const cr = containerRef.current.getBoundingClientRect();
    const start = marqueeStartRef.current;

    const left = Math.min(start.clientX, e.clientX) - cr.left;
    const top = Math.min(start.clientY, e.clientY) - cr.top;
    const width = Math.abs(e.clientX - start.clientX);
    const height = Math.abs(e.clientY - start.clientY);

    setMarqueeRect({ x: left, y: top, w: width, h: height });

    // Tìm các từ nằm trong khung marquee (hệ tọa độ ảnh gốc)
    const imgLeft = left / scale;
    const imgTop = top / scale;
    const imgRight = (left + width) / scale;
    const imgBottom = (top + height) / scale;

    const matched = words.filter((w) => {
      const wx2 = w.x + w.w;
      const wy2 = w.y + w.h;
      return !(wx2 < imgLeft || w.x > imgRight || wy2 < imgTop || w.y > imgBottom);
    });
    setMarqueeWords(matched);
  };

  const handleContainerMouseUp = (e: React.MouseEvent) => {
    if (boxSelectMode && isDraggingMarquee.current) {
      isDraggingMarquee.current = false;
      const start = marqueeStartRef.current;
      marqueeStartRef.current = null;

      if (start && containerRef.current) {
        const cr = containerRef.current.getBoundingClientRect();
        const left = Math.min(start.clientX, e.clientX) - cr.left;
        const top = Math.min(start.clientY, e.clientY) - cr.top;
        const width = Math.abs(e.clientX - start.clientX);
        const height = Math.abs(e.clientY - start.clientY);

        if (width >= 6 && height >= 6) {
          const finalRect = { x: left, y: top, w: width, h: height };
          setMarqueeRect(finalRect);

          const imgLeft = left / scale;
          const imgTop = top / scale;
          const imgRight = (left + width) / scale;
          const imgBottom = (top + height) / scale;

          const matched = words.filter((w) => {
            const wx2 = w.x + w.w;
            const wy2 = w.y + w.h;
            return !(wx2 < imgLeft || w.x > imgRight || wy2 < imgTop || w.y > imgBottom);
          });

          setMarqueeWords(matched);

          if (matched.length > 0) {
            const text = formatWordsToText(matched, renderLines);
            const px = Math.max(10, Math.min(cr.width - 180, left + width / 2 - 80));
            const py = Math.max(8, top - 46);
            setPopup({
              text,
              x: px,
              y: py,
              words: matched,
            });
          }
        }
      }
      return;
    }

    handleMouseUp(e);
  };

  const handleRedact = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!popup) return;
    if (popup.words.length > 0) {
      onRedactWords?.(popup.words);
    } else {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && containerRef.current) {
        const range = sel.getRangeAt(0);
        const r = range.getBoundingClientRect();
        const cr = containerRef.current.getBoundingClientRect();
        const imgX = (r.left - cr.left) / scale;
        const imgY = (r.top - cr.top) / scale;
        const imgW = r.width / scale;
        const imgH = r.height / scale;
        onRedactWords?.([{ text: popup.text, x: imgX, y: imgY, w: imgW, h: imgH }]);
      }
    }
    window.getSelection()?.removeAllRanges();
    setPopup(null);
    setMarqueeRect(null);
    setMarqueeWords([]);
  };

  if (!enabled || !words || words.length === 0) return null;

  return (
    <>
      {/* Floating Control Bar cố định ở đỉnh màn hình (ngay dưới Toolbar chính 74px):
          Đặt top: 84px để không bao giờ bị che một nửa bởi Toolbar! */}
      <div
        className="snapdoc-live-text-topbar"
        style={{
          position: "fixed",
          top: 84,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 8px",
          borderRadius: 20,
          background: "rgba(15, 23, 42, 0.94)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          border: "1px solid rgba(59, 130, 246, 0.45)",
          boxShadow: "0 6px 20px rgba(0, 0, 0, 0.6), 0 0 10px rgba(59, 130, 246, 0.25)",
          zIndex: 100,
          pointerEvents: "auto",
          whiteSpace: "nowrap",
        }}
      >
        {engine && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 9px",
              borderRadius: 12,
              fontSize: 11,
              fontWeight: 600,
              background:
                engine === "viesvtr"
                  ? "rgba(16, 185, 129, 0.22)"
                  : engine === "tesseract"
                  ? "rgba(245, 158, 11, 0.22)"
                  : "rgba(59, 130, 246, 0.22)",
              border:
                engine === "viesvtr"
                  ? "1px solid rgba(16, 185, 129, 0.45)"
                  : engine === "tesseract"
                  ? "1px solid rgba(245, 158, 11, 0.45)"
                  : "1px solid rgba(59, 130, 246, 0.45)",
              color:
                engine === "viesvtr"
                  ? "#6ee7b7"
                  : engine === "tesseract"
                  ? "#fcd34d"
                  : "#93c5fd",
              cursor: engineError ? "help" : "default",
            }}
            title={
              engineError
                ? `Engine OCR hiện tại: Windows OCR (Dự phòng do sự cố:\n${engineError}\nBấm vào để xem chi tiết)`
                : `Engine OCR hiện tại: ${
                    engine === "viesvtr"
                      ? "Mô hình Trí tuệ nhân tạo Deep Learning VieSVTR (Chính xác cao)"
                      : engine === "tesseract"
                      ? "Mô hình Tesseract OCR Offline"
                      : "Windows Native OCR Engine"
                  }`
            }
            onClick={() => {
              if (engineError) {
                alert(`[SnapDoc OCR Sự Cố]\n\n${engineError}\n\n-> Hệ thống tự động chuyển sang Windows Native OCR để đảm bảo không gián đoạn công việc của bạn.`);
              }
            }}
          >
            {engine === "viesvtr" ? "🤖 VieSVTR (AI)" : engine === "tesseract" ? "⚡ Tesseract" : `🪟 Windows OCR${engineError ? " ⚠️" : ""}`}
          </span>
        )}

        <button
          type="button"
          onClick={handleCopyAll}
          style={topBarBtnStyle}
          title="Sao chép toàn bộ chữ trong ảnh vào Clipboard (Ctrl+C)"
        >
          📋 Copy tất cả
        </button>

        {/* Chế độ khoanh vùng kéo hộp chữ nhật tự do */}
        <button
          type="button"
          onClick={() => {
            setBoxSelectMode((v) => !v);
            setMarqueeRect(null);
            setMarqueeWords([]);
            window.getSelection()?.removeAllRanges();
            setPopup(null);
          }}
          style={{
            ...topBarBtnStyle,
            background: boxSelectMode ? "rgba(59, 130, 246, 0.35)" : topBarBtnStyle.background,
            borderColor: boxSelectMode ? "#3b82f6" : undefined,
            color: boxSelectMode ? "#93c5fd" : topBarBtnStyle.color,
          }}
          title="Kéo hộp chữ nhật để khoanh chọn chính xác bất kỳ vùng văn bản nào (chống dính cột tuyệt đối)"
        >
          ⬚ Kéo hộp chọn {boxSelectMode ? "✓" : ""}
        </button>

        {onOpenInspector && (
          <button
            type="button"
            onClick={onOpenInspector}
            style={topBarBtnStyle}
            title="Mở bảng xem văn bản chi tiết & đổi ngôn ngữ"
          >
            👁️ Xem văn bản
          </button>
        )}

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            style={{
              ...topBarBtnStyle,
              background: "rgba(239, 68, 68, 0.2)",
              border: "1px solid rgba(239, 68, 68, 0.45)",
              color: "#fca5a5",
              fontWeight: 600,
            }}
            title="Tắt chế độ Live Text để tiếp tục vẽ & chỉnh sửa ảnh bình thường (Phím Esc)"
          >
            ✕ Tắt Live Text (Esc)
          </button>
        )}
      </div>

      <div
        ref={containerRef}
        onMouseDown={handleContainerMouseDown}
        onMouseMove={handleContainerMouseMove}
        onMouseUp={handleContainerMouseUp}
        style={{
          position: "absolute",
          left: offsetX,
          top: offsetY,
          width: imgW * scale,
          height: imgH * scale,
          pointerEvents: "auto",
          zIndex: 45,
          userSelect: boxSelectMode ? "none" : "text",
          cursor: boxSelectMode ? "crosshair" : "text",
          overflow: "visible",
        }}
      >
        {/* Render theo từng Cột/Khung riêng biệt: 100% cô lập DOM giữa Sidebar và Main Content */}
        {columns.map((col) => (
          <div
            key={col.id}
            className="snapdoc-live-text-column"
            style={{
              position: "absolute",
              left: `${col.x * scale}px`,
              top: `${col.y * scale}px`,
              width: `${col.w * scale}px`,
              height: `${col.h * scale}px`,
              pointerEvents: boxSelectMode ? "none" : "auto",
              userSelect: boxSelectMode ? "none" : "text",
              cursor: boxSelectMode ? "crosshair" : "text",
              overflow: "visible",
            }}
          >
            {col.lines.map((line) => {
              const lineLeft = (line.x - col.x) * scale;
              const lineTop = (line.y - col.y) * scale;
              const lineWidth = Math.max(line.w * scale, 12);
              const lineHeight = Math.max(line.h * scale, 14);
              const fontSize = Math.max(lineHeight * 0.72, 10);

              return (
                <div
                  key={line.id}
                  className="snapdoc-live-text-line"
                  style={{
                    position: "absolute",
                    left: `${lineLeft}px`,
                    top: `${lineTop}px`,
                    width: `${lineWidth}px`,
                    height: `${lineHeight}px`,
                    fontSize: `${fontSize}px`,
                    fontFamily: 'Consolas, "Segoe UI", -apple-system, BlinkMacSystemFont, "Roboto", monospace, sans-serif',
                    color: "transparent",
                    overflow: "visible",
                    userSelect: boxSelectMode ? "none" : "text",
                    cursor: boxSelectMode ? "crosshair" : "text",
                    boxSizing: "border-box",
                    pointerEvents: boxSelectMode ? "none" : "auto",
                  }}
                >
                  {line.words.map((item, i) => {
                    const isMarqueeSelected = marqueeWords.includes(item.word);
                    const wordLeft = (item.word.x - line.x) * scale;
                    const wordTop = (item.word.y - line.y) * scale;
                    const wordWidth = Math.max(item.word.w * scale, 6);
                    const wordHeight = Math.max(item.word.h * scale, lineHeight);

                    return (
                      <span
                        key={i}
                        className={`snapdoc-live-text-word ${isMarqueeSelected ? "snapdoc-word-marquee-selected" : ""}`}
                        data-index={item.index}
                        data-word-text={item.word.text}
                        data-word-x={item.word.x}
                        data-word-y={item.word.y}
                        style={{
                          position: "absolute",
                          left: `${wordLeft}px`,
                          top: `${wordTop}px`,
                          width: `${wordWidth}px`,
                          height: `${wordHeight}px`,
                          lineHeight: `${wordHeight}px`,
                          color: "transparent",
                          userSelect: boxSelectMode ? "none" : "text",
                          cursor: boxSelectMode ? "crosshair" : "text",
                          background: isMarqueeSelected ? "rgba(59, 130, 246, 0.45)" : undefined,
                          boxSizing: "border-box",
                          overflow: "hidden",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.word.text}
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ))}

        {/* Khung vẽ Marquee Box khi kéo chuột */}
        {marqueeRect && (
          <div
            className="snapdoc-marquee-box"
            style={{
              left: `${marqueeRect.x}px`,
              top: `${marqueeRect.y}px`,
              width: `${marqueeRect.w}px`,
              height: `${marqueeRect.h}px`,
            }}
          />
        )}

        {/* Floating Action Menu nổi lên khi bôi đen */}
        {popup && (
          <div
            className="snapdoc-live-text-popup"
            style={{
              position: "absolute",
              left: `${popup.x}px`,
              top: `${popup.y}px`,
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 8px",
              borderRadius: 8,
              background: "rgba(18, 18, 24, 0.95)",
              backdropFilter: "blur(12px)",
              border: "1px solid rgba(255, 255, 255, 0.18)",
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0,0,0,0.3)",
              zIndex: 60,
              animation: "fadeIn 0.15s ease",
              pointerEvents: "auto",
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={handleCopy}
              style={{
                ...actionBtnStyle,
                background: copiedPopup ? "rgba(16, 185, 129, 0.25)" : undefined,
                borderColor: copiedPopup ? "rgba(16, 185, 129, 0.5)" : undefined,
                color: copiedPopup ? "#34d399" : undefined,
              }}
              title="Sao chép đoạn đã chọn (Ctrl+C)"
            >
              <span>{copiedPopup ? "✓" : "📋"}</span>
              <span>{copiedPopup ? "Đã sao chép!" : "Sao chép"}</span>
            </button>

            {onRedactWords && (
              <button
                type="button"
                onPointerDown={handleRedact}
                onClick={handleRedact}
                style={{
                  ...actionBtnStyle,
                  background: "rgba(239, 68, 68, 0.2)",
                  borderColor: "rgba(239, 68, 68, 0.4)",
                  color: "#fca5a5",
                }}
                title="Che mờ / Bảo mật các từ nhạy cảm đã bôi đen"
              >
                <span>🔒</span>
                <span>Che mờ</span>
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

const topBarBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 10px",
  borderRadius: 14,
  background: "rgba(255, 255, 255, 0.08)",
  border: "1px solid rgba(255, 255, 255, 0.14)",
  color: "#f1f5f9",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  transition: "all 0.15s ease",
};

const actionBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  padding: "4px 9px",
  borderRadius: 6,
  background: "rgba(59, 130, 246, 0.2)",
  border: "1px solid rgba(59, 130, 246, 0.45)",
  color: "#93c5fd",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  transition: "background 0.12s ease",
};
