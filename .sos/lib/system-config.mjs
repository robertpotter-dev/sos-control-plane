import os from 'os';

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, join, relative } from 'path';

export const SYSTEM_CONFIG_RELATIVE_PATH = join('.sos', 'config.json');
export const LEGACY_SYSTEM_CONFIG_RELATIVE_PATH = 'sos.config.json';

export function readSystemConfig(repoRoot) {
    const canonical = join(repoRoot, SYSTEM_CONFIG_RELATIVE_PATH);
    const legacy = join(repoRoot, LEGACY_SYSTEM_CONFIG_RELATIVE_PATH);
    const path = existsSync(canonical) ? canonical : existsSync(legacy) ? legacy : null;
    if (!path) {
        return { exists: false, path: canonical, relativePath: SYSTEM_CONFIG_RELATIVE_PATH, data: {} };
    }
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        return { exists: true, path, relativePath: relative(repoRoot, path), data };
    } catch {
        return { exists: true, path, relativePath: relative(repoRoot, path), data: {}, invalid: true };
    }
}

export function configuredSystemName(repoRoot) {
    const { data } = readSystemConfig(repoRoot);
    return typeof data.systemName === 'string' && data.systemName.trim() ? data.systemName : basename(repoRoot);
}

export function instanceLabel(repoRoot) {
    const { data } = readSystemConfig(repoRoot);
    if (typeof data.systemName === 'string' && data.systemName.trim()) return data.systemName.trim();
    return basename(repoRoot);
}

export function expandHomePath(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.replace(/^~(?=\/|\\)/, os.homedir());
}

function storedPaths(values) {
    return values.filter(value => typeof value === 'string' && value.trim());
}

export function configuredVaults(repoRoot) {
    if (process.env.SOS_OBSIDIAN_ROOT) return storedPaths([process.env.SOS_OBSIDIAN_ROOT]);
    const { data } = readSystemConfig(repoRoot);
    if (Array.isArray(data.vaults)) return storedPaths(data.vaults);
    if (typeof data.obsidianTarget === 'string') return storedPaths([data.obsidianTarget]);
    return [];
}

export function configuredMirrors(repoRoot) {
    const { data } = readSystemConfig(repoRoot);
    if (Array.isArray(data.mirrors)) return storedPaths(data.mirrors);
    if (typeof data.mirrorTarget === 'string') return storedPaths([data.mirrorTarget]);
    return [];
}

export function resolvedVaults(repoRoot) {
    return configuredVaults(repoRoot).map(expandHomePath).filter(Boolean);
}

export function resolvedMirrors(repoRoot) {
    return configuredMirrors(repoRoot).map(expandHomePath).filter(Boolean);
}


export function writeSystemConfig(repoRoot, { systemName, created, vaults = [], mirrors = [] }) {
    mkdirSync(join(repoRoot, '.sos'), { recursive: true });
    const path = join(repoRoot, SYSTEM_CONFIG_RELATIVE_PATH);
    const payload = { version: 1, systemName, created, vaults, mirrors };

    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' });
    relocateLegacySystemConfig(repoRoot);
    return path;
}

export function relocateLegacySystemConfig(repoRoot) {
    const canonical = join(repoRoot, SYSTEM_CONFIG_RELATIVE_PATH);
    const legacy = join(repoRoot, LEGACY_SYSTEM_CONFIG_RELATIVE_PATH);
    if (!existsSync(legacy)) return canonical;
    mkdirSync(join(repoRoot, '.sos'), { recursive: true });
    if (!existsSync(canonical)) renameSync(legacy, canonical);
    else unlinkSync(legacy);
    return canonical;
}

export function updateSystemConfig(repoRoot, updates) {
    const { data } = readSystemConfig(repoRoot);
    const merged = { ...data, ...updates };
    const path = join(repoRoot, SYSTEM_CONFIG_RELATIVE_PATH);
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf-8' });
    return merged;
}
