import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, relative } from 'path';
import { fileURLToPath } from 'url';

import { localDateString } from './debrief.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { decodeForVision, disposeDecoded } from './image-decode.mjs';
import { readJpegExif } from './jpeg-exif.mjs';
import { commandExists } from './tools.mjs';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tiff', '.tif', '.dng', '.avif', '.gif']);

function collectImages(targetPath) {
    const stat = statSync(targetPath);
    if (stat.isFile()) {
        return IMAGE_EXTS.has(extname(targetPath).toLowerCase()) ? [targetPath] : [];
    }
    const found = [];
    for (const name of readdirSync(targetPath).sort()) {
        if (name.startsWith('.')) continue;
        const path = join(targetPath, name);
        if (statSync(path).isDirectory()) found.push(...collectImages(path));
        else if (IMAGE_EXTS.has(extname(name).toLowerCase())) found.push(path);
    }
    return found;
}

function aspectRatio(width, height) {
    if (!width || !height) return 'Other';
    const ratio = width / height;
    if (Math.abs(ratio - 1) < 0.05) return '1:1 Square';
    if (ratio < 0.95) return Math.abs(ratio - 0.8) < 0.08 ? '4:5 Portrait' : 'Vertical Portrait';
    return 'Horizontal Landscape';
}

function ocrWithTesseract(path) {
    if (!commandExists('tesseract')) return null;
    const result = spawnSync('tesseract', [path, 'stdout'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 8 * 1024 * 1024
    });
    if ((result.status ?? 1) !== 0) return null;
    const lines = String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines.length ? lines : null;
}

function ocrWithWindows(path) {
    if (process.platform !== 'win32') return null;
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'windows', 'ocr.ps1');
    if (!existsSync(script)) return null;
    const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ImagePath', path], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 8 * 1024 * 1024
    });
    if ((result.status ?? 1) !== 0) return null;
    const lines = String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines.length ? lines : null;
}

function recognizeText(path) {
    return ocrWithTesseract(path) || ocrWithWindows(path);
}

export function describeVisionEngine() {
    if (commandExists('tesseract')) return 'Tesseract OCR (not Apple Vision)';
    if (process.platform === 'win32') return 'Windows.Media.Ocr fallback (not Apple Vision)';
    return 'file telemetry only (no OCR engine)';
}

function domainMeta(repoRoot, domainName) {
    const spaceFile = join(repoRoot, domainName, 'SPACE.md');
    if (!existsSync(spaceFile)) return { exposure: 'public', parent: `${domainName.slice(0, 4)}:charter` };
    const parsed = parseFrontmatter(readFileSync(spaceFile, 'utf-8'));
    return {
        exposure: parsed?.exposure || 'public',
        parent: parsed?.id || `${domainName.slice(0, 4)}:charter`
    };
}

function analyzeImage(imagePath) {
    const decoded = decodeForVision(imagePath);
    try {
        const ocrText = recognizeText(decoded.path);
        const exif = readJpegExif(decoded.path) || readJpegExif(imagePath);
        return {
            filename: basename(imagePath),
            relativePath: basename(imagePath),
            width: decoded.width,
            height: decoded.height,
            aspectRatio: aspectRatio(decoded.width, decoded.height),
            averageLuminance: null,
            colorWarmth: null,
            lightingCategory: null,
            decoder: decoded.decoder,
            exif,
            neuralTags: [],
            ocrText
        };
    } finally {
        disposeDecoded(decoded);
    }
}

function writeManifest({ results, manifestPath, telemetryPath, assetId, domainName, exposure, parent, engine }) {
    const date = localDateString();
    const jsonName = basename(telemetryPath);
    const counts = {};
    for (const item of results) {
        counts[item.aspectRatio] = (counts[item.aspectRatio] || 0) + 1;
    }
    const ocrRows = results.filter(item => item.ocrText?.length);
    const lines = [
        '---',
        `id: "${assetId}"`,
        `parent: "${parent}"`,
        'related: []',
        `title: "Asset Telemetry: Portable OCR and Photographic Extraction Ledger"`,
        `description: "Tier 2 machine extraction ledger: ${engine} across ${results.length} visual asset(s). This is not Apple Vision scene classification."`,
        'type: "asset-manifest"',
        `domain: "${domainName}"`,
        `exposure: "${exposure}"`,
        'status: "active"',
        `created: ${date}`,
        `updated: ${date}`,
        `tags: ["${domainName}", "asset-manifest", "ocr", "telemetry", "verbatim-ledger"]`,
        '---',
        '',
        '# Asset Telemetry: Portable OCR and Photographic Extraction Ledger',
        '',
        '> Script-generated machine ledger. OCR and EXIF only. No neural scene tags. Synthesis belongs in Tier 1.',
        '',
        `**Extraction Engine:** ${engine}`,
        `**Dataset Scope:** ${results.length} visual asset(s)`,
        `**Raw JSON Telemetry (Tier 3):** [${jsonName}](../inbox/archive/${jsonName})`,
        '',
        '## 1. Framing & Geometric Ratios',
        '',
        '| Aspect Ratio Classification | Asset Count |',
        '| :--- | :--- |'
    ];
    for (const [aspect, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        lines.push(`| \`${aspect}\` | **${count}** |`);
    }
    const gps = results.filter(item => item.exif?.latitude != null && item.exif?.longitude != null);
    if (gps.length) {
        lines.push('', '## 2. Geospatial Telemetry', '', '| Filename | Coordinates | Camera |', '| :--- | :--- | :--- |');
        for (const item of gps) {
            const cam = [item.exif.make, item.exif.model].filter(Boolean).join(' ');
            lines.push(`| \`${item.filename}\` | \`${item.exif.latitude.toFixed(5)}, ${item.exif.longitude.toFixed(5)}\` | ${cam || 'N/A'} |`);
        }
    }
    lines.push('', '## Verbatim OCR Inscription Index', '');
    if (!ocrRows.length) {
        lines.push('_No OCR text was recognized. The files were still archived._', '');
    } else {
        lines.push('| Filename | Dimensions | Verbatim OCR Recognized Text |', '| :--- | :--- | :--- |');
        for (const item of ocrRows) {
            const ocr = item.ocrText.join(' • ').replace(/\|/g, '/').replace(/#/g, '\\#');
            lines.push(`| \`${item.filename}\` | \`${item.width}x${item.height}\` | ${ocr} |`);
        }
        lines.push('');
    }
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${lines.join('\n')}\n`, 'utf-8');
}

export function runPortableVision({ targetPath, domainName, manifestPath, telemetryPath, assetId, repoRoot }) {
    if (!existsSync(targetPath)) throw new Error(`Vision target does not exist: ${targetPath}`);
    const images = collectImages(targetPath);
    if (!images.length) throw new Error(`No images found at ${targetPath}`);

    const engine = describeVisionEngine();
    const results = images.map(imagePath => {
        const item = analyzeImage(imagePath);
        item.relativePath = relative(targetPath, imagePath) || item.filename;
        if (images.length === 1) item.relativePath = item.filename;
        return item;
    });

    mkdirSync(dirname(telemetryPath), { recursive: true });
    writeFileSync(telemetryPath, `${JSON.stringify(results, null, 2)}\n`, 'utf-8');
    const meta = domainMeta(repoRoot, domainName);
    writeManifest({
        results,
        manifestPath,
        telemetryPath,
        assetId,
        domainName,
        exposure: meta.exposure,
        parent: meta.parent,
        engine
    });
    return results;
}

export function runPortableKeyframeVision(imagePath) {
    const item = analyzeImage(imagePath);
    return {
        ...item,
        averageLuminance: 0,
        colorWarmth: null,
        lightingCategory: null,
        ocrText: item.ocrText || []
    };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
    const [targetPath, domainName, manifestPath, telemetryPath, assetId] = process.argv.slice(2);
    if (!targetPath || !domainName || !manifestPath || !telemetryPath || !assetId) {
        console.error('Usage: node portable-vision.mjs <target> <domain> <manifest.md> <telemetry.json> <id>');
        process.exit(1);
    }
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    runPortableVision({ targetPath, domainName, manifestPath, telemetryPath, assetId, repoRoot });
}
