import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { executeVision, extractPdfText, normalizeVisionIndex } from '../lib/sensors.mjs';
import { decodeForVision, readImageSize } from '../lib/image-decode.mjs';
import { readJpegExif } from '../lib/jpeg-exif.mjs';
import { formatPdfPages } from '../lib/portable-pdf.mjs';
import { describeVisionEngine, runPortableVision } from '../lib/portable-vision.mjs';
import { mirrorTree } from '../lib/mirror-tree.mjs';
import { findExtractedControlPlane } from '../lib/archive-fetch.mjs';
import { readJsonRecords } from '../lib/jsonl.mjs';

const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

const REPO_ROOT = join(import.meta.dirname, '..', '..');

test('cross-platform sensors are functions and plugin files are not stubs', () => {
    assert.equal(typeof extractPdfText, 'function');
    assert.equal(typeof executeVision, 'function');
    const linuxPdf = readFileSync(join(REPO_ROOT, '.sos', 'plugins', 'linux', 'pdf.sh'), 'utf-8');
    const linuxVision = readFileSync(join(REPO_ROOT, '.sos', 'plugins', 'linux', 'vision.sh'), 'utf-8');
    const winPdf = readFileSync(join(REPO_ROOT, '.sos', 'plugins', 'windows', 'pdf.ps1'), 'utf-8');
    const winVision = readFileSync(join(REPO_ROOT, '.sos', 'plugins', 'windows', 'vision.ps1'), 'utf-8');
    const winOcr = readFileSync(join(REPO_ROOT, '.sos', 'plugins', 'windows', 'ocr.ps1'), 'utf-8');
    const appleVision = readFileSync(join(REPO_ROOT, '.sos', 'plugins', 'apple-metal', 'vision.swift'), 'utf-8');
    assert.match(appleVision, /import Vision/);
    for (const source of [linuxPdf, linuxVision, winPdf, winVision, winOcr]) {
        assert.doesNotMatch(source, /Simulated|mocked/i);
    }
    assert.match(linuxPdf, /pdftotext/);
    assert.match(winPdf, /pdftotext/);
    assert.match(linuxVision, /portable-vision/);
    assert.match(winVision, /portable-vision/);
    assert.match(winOcr, /Windows\.Media\.Ocr/);
});

test('readImageSize and decodeForVision treat a PNG as native pixels', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'sos-png-'));
    const path = join(dir, 'dot.png');
    writeFileSync(path, PNG_1X1);
    assert.deepEqual(readImageSize(path), { width: 1, height: 1 });
    const decoded = decodeForVision(path);
    assert.equal(decoded.decoder, 'native');
    assert.equal(decoded.temporary, false);
    assert.equal(decoded.path, path);
    assert.equal(decoded.width, 1);
    assert.equal(decoded.height, 1);
});

test('readJpegExif returns null for a JPEG without EXIF', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'sos-jpeg-'));
    const path = join(dir, 'plain.jpg');
    writeFileSync(path, Buffer.from(
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
        'base64'
    ));
    assert.equal(readJpegExif(path), null);
    assert.equal(typeof readImageSize(path).width, 'number');
});

test('portable vision succeeds when OCR is empty and does not claim Apple Vision', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'sos-vision-'));
    const imagePath = join(dir, 'dot.png');
    writeFileSync(imagePath, PNG_1X1);
    const manifestPath = join(dir, 'assets', 'vision-dot.md');
    const telemetryPath = join(dir, 'assets', 'vision-dot.vision.jsonl');
    const results = runPortableVision({
        targetPath: imagePath,
        domainName: 'personal',
        manifestPath,
        telemetryPath,
        assetId: 'pers:vision-dot',
        repoRoot: dir
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].width, 1);
    assert.equal(results[0].height, 1);
    assert.ok(results[0].ocrText == null || results[0].ocrText.length === 0);
    const manifest = readFileSync(manifestPath, 'utf-8');
    assert.match(manifest, /not Apple Vision/);
    assert.match(manifest, /No OCR text was recognized/);
    assert.match(manifest, /Machine Vision Index \(Tier 2\)/);
    assert.doesNotMatch(manifest, /inbox\/archive/);
    assert.match(describeVisionEngine(), /not Apple Vision|no OCR engine/);
    const telemetry = readJsonRecords(telemetryPath);
    assert.equal(telemetry[0].width, 1);
    assert.equal(telemetry[0].index_line, 1);
    assert.match(telemetry[0].record_id, /^vision:[a-f0-9]{16}:000001$/);
    assert.equal(readFileSync(telemetryPath, 'utf-8').trim().split('\n').length, 1);
});

test('undecoded HEIC still ingests instead of failing the photo', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'sos-heic-'));
    const imagePath = join(dir, 'phone.heic');
    writeFileSync(imagePath, Buffer.from('not a real heic'));
    const results = runPortableVision({
        targetPath: imagePath,
        domainName: 'personal',
        manifestPath: join(dir, 'manifest.md'),
        telemetryPath: join(dir, 'phone.vision.jsonl'),
        assetId: 'pers:vision-phone',
        repoRoot: dir
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].filename, 'phone.heic');
});

test('Apple-style array telemetry is normalized to line-addressable Vision JSONL', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'sos-vision-normalize-'));
    const indexPath = join(dir, 'batch.vision.jsonl');
    writeFileSync(indexPath, `${JSON.stringify([{ filename: 'one.jpg' }, { filename: 'two.jpg' }], null, 2)}\n`);
    const custody = [
        { originalPath: 'personal/inbox/one.jpg', sourceSha256: 'a'.repeat(64) },
        { originalPath: 'personal/inbox/two.jpg', sourceSha256: 'b'.repeat(64) }
    ];
    const records = normalizeVisionIndex(indexPath, custody);
    assert.equal(records.length, 2);
    assert.equal(records[1].record_id, 'vision:bbbbbbbbbbbbbbbb:000002');
    assert.equal(records[1].source_path, 'personal/inbox/two.jpg');
    assert.equal(readFileSync(indexPath, 'utf-8').trim().split('\n').length, 2);
});

test('formatPdfPages splits form-feed pages like PDFKit output', () => {
    assert.equal(formatPdfPages('page one\fpage two'), '## Page 1\n\npage one\n\n## Page 2\n\npage two');
    assert.equal(formatPdfPages(''), '');
});

test('mirrorTree copies source files and deletes dest-only leftovers', () => {
    const src = mkdtempSync(join(os.tmpdir(), 'sos-mirror-src-'));
    const dest = mkdtempSync(join(os.tmpdir(), 'sos-mirror-dest-'));
    mkdirSync(join(src, 'personal'), { recursive: true });
    mkdirSync(join(src, '.sos', 'cache'), { recursive: true });
    writeFileSync(join(src, 'personal', 'note.md'), 'keep\n');
    writeFileSync(join(src, '.sos', 'cache', 'skip.json'), '{}');
    writeFileSync(join(dest, 'stale.txt'), 'gone\n');
    mirrorTree(src, dest);
    assert.equal(readFileSync(join(dest, 'personal', 'note.md'), 'utf-8'), 'keep\n');
    assert.equal(existsSafe(join(dest, 'stale.txt')), false);
    assert.equal(existsSafe(join(dest, '.sos', 'cache', 'skip.json')), false);
});

test('findExtractedControlPlane locates the zip inner folder', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'sos-archive-'));
    const inner = join(root, 'sos-control-plane-main');
    mkdirSync(join(inner, '.sos'), { recursive: true });
    writeFileSync(join(inner, 'AGENTS.md'), '# agents\n');
    writeFileSync(join(inner, '.sos', 'sos.mjs'), '#!/usr/bin/env node\n');
    assert.equal(findExtractedControlPlane(root), inner);
});

function existsSafe(path) {
    try {
        readFileSync(path);
        return true;
    } catch {
        return false;
    }
}
