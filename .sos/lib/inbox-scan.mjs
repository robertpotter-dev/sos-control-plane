import { existsSync, readdirSync, statSync } from 'fs';
import { extname, join, relative, resolve } from 'path';

import { isDebriefRecord } from './debrief.mjs';

import { resolvedVaults } from './system-config.mjs';

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi']);
const MEDIA_EXTS = new Set([...VIDEO_EXTS, '.m4a', '.mp3', '.wav', '.aac', '.flac', '.ogg', '.aiff']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp', '.tiff', '.dng', '.avif']);
const TEXT_EXTS = new Set(['.txt', '.rtf', '.md', '.markdown']);
const DOCUMENT_EXTS = new Set(['.pdf']);
const SPREADSHEET_EXTS = new Set(['.csv', '.xlsx']);

export function classifyInboxFile(path) {
    const extension = extname(path).toLowerCase();
    if (MEDIA_EXTS.has(extension)) return 'media';
    if (IMAGE_EXTS.has(extension)) return 'image';
    if (TEXT_EXTS.has(extension)) return 'text';
    if (DOCUMENT_EXTS.has(extension)) return 'document';
    if (SPREADSHEET_EXTS.has(extension)) return 'spreadsheet';
    return null;
}

export function collectInboxBatchFiles(root, current = root, { strict = false } = {}) {
    const files = [];
    for (const name of readdirSync(current)) {
        if (name.startsWith('.')) continue;
        const path = join(current, name);
        if (statSync(path).isDirectory()) {
            files.push(...collectInboxBatchFiles(root, path, { strict }));
            continue;
        }
        if (isDebriefRecord(name)) continue;
        const type = classifyInboxFile(path);
        if (!type && strict) {
            throw new Error('Unsupported file in batch ' + relative(root, path));
        }
        files.push({
            path,
            file: name,
            relativePath: relative(root, path),
            type: type ?? 'unsupported'
        });
    }
    return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function displayInboxPath(filePath, { repoRoot, vaults = [] }) {
    const local = relative(repoRoot, filePath);
    if (!local.startsWith('..') && !resolve(local).startsWith('..')) return local;

    for (const vault of vaults) {
        const cloud = relative(vault, filePath);
        if (!cloud.startsWith('..')) return join('external', cloud);
    }
    return filePath;
}

export function inboxDirectories(discoverDomains, repoRoot) {
    const directories = [];
    const vaults = resolvedVaults(repoRoot);
    for (const domain of discoverDomains()) {
        const localPath = join(domain.path, 'inbox');
        if (existsSync(localPath)) directories.push({ domain, domainName: domain.name, location: 'local', path: localPath });

        for (const vault of vaults) {
            const mobilePath = join(vault, domain.vaultName, 'inbox');
            if (existsSync(mobilePath)) directories.push({ domain, domainName: domain.name, location: 'external', path: mobilePath });
        }
    }
    return directories;
}

export function scanInboxes(discoverDomains, { repoRoot } = {}) {
    const items = [];
    for (const inbox of inboxDirectories(discoverDomains, repoRoot)) {
        for (const name of readdirSync(inbox.path)) {
            if (name.startsWith('.') || name === 'archive') continue;
            const path = join(inbox.path, name);
            let stat;
            try {
                stat = statSync(path);
            } catch {
                continue;
            }
            const type = stat.isDirectory()
                ? 'batch'
                : isDebriefRecord(name)
                    ? 'debrief'
                    : 'capture';
            items.push({
                domain: inbox.domainName,
                location: inbox.location,
                type,
                name,
                extension: extname(name).toLowerCase(),
                path,
                displayPath: displayInboxPath(path, { repoRoot, vaults: resolvedVaults(repoRoot) })
            });
        }
    }
    return items.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

export function enrichInboxItems(items, verbose) {
    if (!verbose) return items;
    return items.map(item => {
        if (item.type !== 'batch') return item;
        const files = collectInboxBatchFiles(item.path).map(({ relativePath, type }) => ({ relativePath, type }));
        return { ...item, files };
    });
}
