import { createHash } from 'crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

import { parseFrontmatter } from './frontmatter.mjs';

const CHUNK_SIZE = 1024 * 1024;

export function sha256String(value) {
    return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function sha256File(path) {
    const hash = createHash('sha256');
    const fd = openSync(path, 'r');
    try {
        const buffer = Buffer.alloc(CHUNK_SIZE);
        let bytes;
        while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            hash.update(bytes === buffer.length ? buffer : buffer.subarray(0, bytes));
        }
    } finally {
        closeSync(fd);
    }
    return hash.digest('hex');
}

export function readSourceSha256(content) {
    const hex = parseFrontmatter(content)?.source_sha256;
    return hex && /^[a-f0-9]{64}$/.test(hex) ? hex : null;
}

export function findAssetBySourceSha256(assetsDir, hex, { type } = {}) {
    if (!hex || !existsSync(assetsDir)) return null;
    const needle = String(hex).toLowerCase();
    for (const name of readdirSync(assetsDir)) {
        if (!name.endsWith('.md')) continue;
        const path = join(assetsDir, name);
        if (!statSync(path).isFile()) continue;
        const parsed = parseFrontmatter(readFileSync(path, 'utf-8'));
        if (!parsed || parsed.source_sha256 !== needle) continue;
        if (type && parsed.type !== type) continue;
        return path;
    }
    return null;
}

export function archiveMatchesSource(archivePath, sourcePath, sourceSha256) {
    if (!existsSync(archivePath)) return false;
    const archiveStat = statSync(archivePath);
    if (!archiveStat.isFile()) return false;
    if (archiveStat.size !== statSync(sourcePath).size) return false;
    return sha256File(archivePath) === sourceSha256;
}

export function allocateDuplicateArchivePath(archiveDir, baseName, extension) {
    let counter = 2;
    let target = join(archiveDir, `${baseName}-duplicate-${counter}${extension}`);
    while (existsSync(target)) {
        counter++;
        target = join(archiveDir, `${baseName}-duplicate-${counter}${extension}`);
    }
    return target;
}

export function recordSha256InJson(jsonPath, hex) {
    if (!existsSync(jsonPath)) return false;
    try {
        const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        parsed.source_sha256 = hex;
        writeFileSync(jsonPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
        return true;
    } catch {
        return false;
    }
}
