import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { REPO_ROOT } from './domains.mjs';

export const VAULT_MANIFEST_VERSION = 1;

export function vaultManifestPath(root = REPO_ROOT) {
    return join(root, '.sos', 'cache', 'vault-manifest.json');
}

export function loadVaultManifest(root = REPO_ROOT) {
    const path = vaultManifestPath(root);
    if (!existsSync(path)) return { version: VAULT_MANIFEST_VERSION, files: {} };
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        if (parsed?.version !== VAULT_MANIFEST_VERSION || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
            return { version: VAULT_MANIFEST_VERSION, files: {} };
        }
        return { version: VAULT_MANIFEST_VERSION, files: parsed.files };
    } catch {
        return { version: VAULT_MANIFEST_VERSION, files: {} };
    }
}

export function saveVaultManifest(manifest, root = REPO_ROOT) {
    const path = vaultManifestPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
        version: VAULT_MANIFEST_VERSION,
        files: manifest.files || {}
    }, null, 2)}\n`, 'utf-8');
}

export function textFingerprint(sha256) {
    return { kind: 'text', sha256 };
}

export function binaryFingerprint(stat) {
    return { kind: 'binary', size: stat.size, mtimeMs: stat.mtimeMs };
}

export function fingerprintsMatch(left, right) {
    if (!left || !right || left.kind !== right.kind) return false;
    if (left.kind === 'text') return left.sha256 === right.sha256;
    return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

export function pruneManifest(manifest, seenKeys) {
    const files = {};
    for (const key of seenKeys) {
        if (manifest.files[key]) files[key] = manifest.files[key];
    }
    return { version: VAULT_MANIFEST_VERSION, files };
}
