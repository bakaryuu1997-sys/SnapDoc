// Bộ điều khiển WebView2 (CDP) cho SnapDoc E2E — chạy bằng Node 24 (WebSocket/fetch có sẵn).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PORT = 9333;
// `fileURLToPath` giải mã %-escape (đường dẫn dự án có dấu như "dự án") — dùng `.pathname`
// thô sẽ tạo nhầm thư mục "d%E1%BB%B1%20%C3%A1n" ngoài dự án.
export const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "shots");
fs.mkdirSync(SHOTS, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await r.json()).filter((t) => t.type === "page");
}

export function winName(t) {
  const m = /[?&]win=([^&#]+)/.exec(t.url || "");
  return m ? decodeURIComponent(m[1]) : t.url;
}

export async function listWindows() {
  return (await targets()).map((t) => ({ win: winName(t), title: t.title, id: t.id }));
}

export async function waitWindow(name, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = (await targets()).find((x) => winName(x) === name);
    if (t) return t;
    await sleep(300);
  }
  throw new Error(`Không thấy cửa sổ "${name}" sau ${timeoutMs}ms. Hiện có: ${(await listWindows()).map((w) => w.win).join(", ")}`);
}

export async function attach(name, timeoutMs) {
  const t = typeof name === "string" ? await waitWindow(name, timeoutMs) : name;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("không kết nối được CDP"));
  });
  let id = 0;
  const pending = new Map();
  const consoleLog = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === "Runtime.consoleAPICalled") {
      consoleLog.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    } else if (m.method === "Runtime.exceptionThrown") {
      consoleLog.push(`EXCEPTION: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");

  const api = {
    target: t,
    send,
    console: consoleLog,
    close: () => ws.close(),
    /** Chạy biểu thức JS trong trang (hỗ trợ await), trả giá trị JSON. */
    async eval(expr) {
      const r = await send("Runtime.evaluate", {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    /** Gọi lệnh Tauri (IPC thật). */
    invoke: (cmd, args = {}) =>
      api.eval(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`),
    async shot(name, opts = {}) {
      const r = await send("Page.captureScreenshot", { format: "png", ...opts });
      const file = path.join(SHOTS, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      return file;
    },
    async rect(selector) {
      return api.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if(!e) return null; const r = e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2}; })()`);
    },
    async mouse(type, x, y, extra = {}) {
      return send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
    },
    async click(x, y) {
      await api.mouse("mouseMoved", x, y);
      await api.mouse("mousePressed", x, y);
      await api.mouse("mouseReleased", x, y);
    },
    async clickSel(selector) {
      const r = await api.rect(selector);
      if (!r) throw new Error(`Không thấy phần tử ${selector}`);
      await api.click(r.cx, r.cy);
    },
    /** Click phần tử có chứa đúng đoạn chữ (button/div/span...). */
    async clickText(text, tag = "button") {
      const r = await api.eval(`(() => { const els=[...document.querySelectorAll(${JSON.stringify(tag)})]; const e=els.find(x=>x.textContent.trim().includes(${JSON.stringify(text)}) && x.getBoundingClientRect().width>0); if(!e) return null; const r=e.getBoundingClientRect(); return {cx:r.x+r.width/2, cy:r.y+r.height/2}; })()`);
      if (!r) throw new Error(`Không thấy <${tag}> chứa "${text}"`);
      await api.click(r.cx, r.cy);
    },
    async drag(x1, y1, x2, y2, steps = 8) {
      await api.mouse("mouseMoved", x1, y1);
      await api.mouse("mousePressed", x1, y1);
      for (let i = 1; i <= steps; i++) {
        await api.mouse("mouseMoved", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, { buttons: 1 });
        await sleep(12);
      }
      await api.mouse("mouseReleased", x2, y2);
    },
    async key(key, opts = {}) {
      const base = { key, code: opts.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key), windowsVirtualKeyCode: opts.vk ?? 0, modifiers: opts.modifiers ?? 0 };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: opts.text });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },
    async type(text) {
      await send("Input.insertText", { text });
    },
    async text() {
      return api.eval("document.body.innerText");
    },
    async viewport() {
      return api.eval("({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})");
    },
  };
  return api;
}

export function report(rows) {
  for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}  ${r.name}${r.note ? "  — " + r.note : ""}`);
}
