# Sovereign OS: Setup

This folder is your system. Download it, live in it, and add domains. You do not need Git, a second clone, or a GitHub account.

A separate local copy is optional insurance, or a private place to develop the control plane. It is not required.

## 1. Prerequisites

- **Node.js 18+**
- Optional sensor tools, probed by `sos doctor`. Missing tools skip that job; they do not block the control plane.

| Job | macOS | Linux / Windows |
| :--- | :--- | :--- |
| Speech | `whisper-cli` + `afconvert` or `ffmpeg` | `whisper-cli` (or `whisper-cpp`) + `ffmpeg` except `.wav` |
| Photos | Apple Vision (Swift) | Tesseract or Windows OCR for text in pictures. No scene tags. Empty OCR is still a successful ingest. |
| HEIC / DNG / AVIF | Apple Vision | Decode with `ffmpeg`, ImageMagick (`magick`), or `heif-convert` before OCR |
| PDF | Swift PDFKit | `pdftotext` from poppler |
| RTF | `textutil` | `pandoc` or `unrtf` |
| Fetch | `yt-dlp` + `ffmpeg` | `yt-dlp` + `ffmpeg` |

The kernel is the same on every OS. macOS runs `.sos/plugins/apple-metal` (Swift Vision and PDFKit) because that hardware is the best local fit. Linux and Windows use the portable Node sensors plus `.sos/plugins/linux` and `.sos/plugins/windows`.

These binaries are not in the zip. Install them yourself:

- macOS: Xcode CLT for Vision/PDFKit; `brew install whisper-cpp ffmpeg tesseract poppler yt-dlp` as needed
- Linux: `ffmpeg`, `tesseract-ocr`, `poppler-utils`, `pandoc`; put `whisper-cli` on PATH
- Windows: `ffmpeg`, `tesseract`, poppler; Windows OCR is a fallback, not Apple Vision

Git is optional. Use it only if you want history of your notes.

## 2. Deploy

macOS / Linux:

```bash
curl -L https://github.com/robertpotter-dev/sos-control-plane/archive/refs/heads/main.zip -o sos.zip
unzip sos.zip
mv sos-control-plane-main ~/Documents/Sovereign-Memory
rm sos.zip
cd ~/Documents/Sovereign-Memory
```

Windows (PowerShell):

```powershell
curl.exe -L https://github.com/robertpotter-dev/sos-control-plane/archive/refs/heads/main.zip -o sos.zip
tar -xf sos.zip
move sos-control-plane-main $env:USERPROFILE\Documents\Sovereign-Memory
del sos.zip
cd $env:USERPROFILE\Documents\Sovereign-Memory
```

Run commands as `node .sos/sos.mjs …` from that folder, or `npm link` and use `sos`.

Optional: `git init` inside the folder if you want your own history. Do not treat this as a pull-request workflow.

## 3. Mint domains

```bash
node .sos/sos.mjs init --domain personal:private
node .sos/sos.mjs init --domain projects:restricted
```

Optional `--name` writes a dashboard label. Charter each `SPACE.md` in debrief before minting notes.

## 4. Vaults and mirrors (both optional)

A **vault** is a parent folder. Sync compiles each domain into `{vault}/{VaultName}/`. `personal` becomes `Personal`. Mobile captures belong in `{vault}/Personal/inbox/`, not `personal/inbox`.

You can point Obsidian, Logseq, VS Code, or the OS file manager at `Personal` (one vault per domain). Cross-domain `obsidian://` links expect those Title-Case folders to be separate vaults. Opening the parent folder as one vault still works as files.

```bash
node .sos/sos.mjs config add vault "/path/to/parent"
node .sos/sos.mjs config add mirror "/path/to/backup"
node .sos/sos.mjs config list
```

Mirrors are raw copies of the whole instance, written to `{mirror}/{folder-name}/`. They use `rsync` when present, otherwise a local copy.

`sos sync` succeeds with no vaults, no mirrors, or both. Compilation runs only when a vault is configured. `sos sync --vaults` fails if none are configured.

## 5. Mobile capture

1. Sync the vault parent (or each `{VaultName}` folder) with iCloud Drive, Dropbox, Syncthing, or any file sync tool.
2. Drop photos, voice memos, PDFs, and notes into `{VaultName}/inbox/` on the device.
3. On the desktop: `node .sos/sos.mjs ingest`, then debrief in chat, then `node .sos/sos.mjs sync`.

## 6. Daily loop

```bash
node .sos/sos.mjs inbox
node .sos/sos.mjs ingest
# debrief in your AI chat
node .sos/sos.mjs sync
```

## 7. Upgrade

From the living instance:

```bash
node .sos/sos.mjs upgrade
```

This downloads the published zip and overlays `.sos` tooling, `AGENTS.md`, `DEBRIEF.md`, `SETUP.md`, `package.json`, and `.gitignore`. It keeps `.sos/config.json`, `.sos/operator-preferences.json`, instance plugins that have `plugin.json`, and every domain note and inbox.

If you keep a local source for insurance or development:

```bash
node .sos/sos.mjs upgrade --path /path/to/local/sos-control-plane
```

Git clone is not part of this product.
