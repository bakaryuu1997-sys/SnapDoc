# Security Policy

## Supported versions

SnapDoc is a rolling-release desktop app — only the latest published release
is supported. Please make sure you're on the latest version (Settings →
Check for updates) before reporting an issue.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report it privately via GitHub's
[private vulnerability reporting](../../security/advisories/new) feature on
this repository, or by emailing the maintainer directly. Include:

- A description of the vulnerability and its impact.
- Steps to reproduce (OS + version, SnapDoc version).
- Any relevant logs or proof-of-concept.

You should get an acknowledgement within a few days. Once a fix is available,
we'll coordinate disclosure timing with you and credit you in the release
notes (unless you prefer to stay anonymous).

## Scope notes specific to SnapDoc

A few areas are worth flagging explicitly since they're the highest-impact
attack surface for a desktop app like this:

- **Auto-update**: automatic updates are **disabled** in this personal fork
  (`src-tauri/src/update.rs` never contacts a server). Upgrade by installing a
  newer setup file you built yourself. The updater plugin entry in
  `tauri.conf.json` still carries the upstream endpoint/public key; it is
  inert while `update.rs` is disabled — remove it before re-enabling updates,
  otherwise the app would trust the upstream author's signing key.
- **Google Drive sign-in**: OAuth uses PKCE `S256` and a random `state`; the
  loopback listener ignores any request that is not the exact callback for the
  current attempt. Tokens are encrypted with Windows DPAPI.
- **Per-window Tauri capabilities**: `capabilities/default.json` is limited to
  the work windows (editor, history, settings); `capabilities/utility.json`
  is a narrow set for transient windows. New window labels must be added to
  the right file.
- **Untrusted files**: `.snapdoc` containers are read with per-entry
  decompressed-size caps (zip-bomb protection); downloaded subtitle
  engine/models are SHA-256 pinned.
- **AI-agent (MCP) server**: off by default, loopback only, bearer token,
  rejects any `Origin` and foreign `Host`, write permission is a separate
  switch, destructive actions need a native confirmation dialog, all actions
  are audit-logged.
- **Known hardening TODOs**: the CSP still contains `'unsafe-eval'` in
  `script-src` (needed by some WASM/OCR code paths — try removing it and run
  the OCR E2E); the Windows installer is not code-signed.
- **Clipboard / filesystem access**: SnapDoc writes captured images/video to
  disk and to the OS clipboard. Path handling for save locations and
  filenames (`src-tauri/src/storage/`) is in scope.
- **Local IPC surface**: the Tauri command surface (`src-tauri/src/commands.rs`
  and friends) is the boundary between the webview and native code —
  anything that lets webview-side content invoke a command outside its
  intended permissions is in scope.

Third-party dependency vulnerabilities (npm/cargo advisories) are welcome
too, but please check `npm audit` / `cargo audit` first so we're not
duplicating an already-tracked upstream issue.
