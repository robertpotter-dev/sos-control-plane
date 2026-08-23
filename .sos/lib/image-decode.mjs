import { existsSync, readFileSync, unlinkSync } from 'fs';
import { extname, join } from 'path';
import os from 'os';

import { commandExists, runTool } from './tools.mjs';

export const DECODE_EXTS = new Set(['.heic', '.heif', '.avif', '.dng', '.tif', '.tiff']);

export function readImageSize(path) {
    const buf = readFileSync(path);
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        if (buf.toString('ascii', 12, 16) === 'VP8 ') {
            return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        }
        if (buf.toString('ascii', 12, 16) === 'VP8L' && buf.length >= 25) {
            const bits = buf.readUInt32LE(21);
            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
    }
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
        let offset = 2;
        while (offset < buf.length - 8) {
            if (buf[offset] !== 0xFF) break;
            const marker = buf[offset + 1];
            const size = buf.readUInt16BE(offset + 2);
            if (marker >= 0xC0 && marker <= 0xC3) {
                return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
            }
            offset += 2 + size;
        }
    }
    return { width: 0, height: 0 };
}

function convertWithAvailableTool(sourcePath, destPath) {
    const attempts = [];
    if (commandExists('magick')) attempts.push(['magick', [sourcePath, destPath]]);
    if (commandExists('convert')) attempts.push(['convert', [sourcePath, destPath]]);
    if (commandExists('heif-convert')) attempts.push(['heif-convert', [sourcePath, destPath]]);
    if (commandExists('ffmpeg')) attempts.push(['ffmpeg', ['-y', '-i', sourcePath, '-map_metadata', '0', destPath]]);
    for (const [command, args] of attempts) {
        try {
            runTool(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
            if (existsSync(destPath)) return command;
        } catch {
            // try the next decoder
        }
    }
    return null;
}

export function decodeForVision(sourcePath) {
    const ext = extname(sourcePath).toLowerCase();
    const native = readImageSize(sourcePath);
    if (native.width && native.height && !DECODE_EXTS.has(ext)) {
        return { path: sourcePath, temporary: false, width: native.width, height: native.height, decoder: 'native' };
    }
    const destPath = join(os.tmpdir(), `sos-decode-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`);
    const decoder = convertWithAvailableTool(sourcePath, destPath);
    if (decoder) {
        const decoded = readImageSize(destPath);
        return {
            path: destPath,
            temporary: true,
            width: decoded.width || native.width,
            height: decoded.height || native.height,
            decoder
        };
    }
    return { path: sourcePath, temporary: false, width: native.width, height: native.height, decoder: null };
}

export function disposeDecoded(decoded) {
    if (!decoded?.temporary) return;
    try {
        unlinkSync(decoded.path);
    } catch {
        // temp cleanup is best-effort
    }
}
