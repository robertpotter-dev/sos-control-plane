import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export function currentWorkingDirectory() {
    try {
        return process.cwd();
    } catch {
        return null;
    }
}

export function findSystemRoot(startPath = currentWorkingDirectory()) {
    if (!startPath) return null;
    let candidate = resolve(startPath);
    while (true) {
        if (existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, '.sos', 'lib', 'domains.mjs'))) {
            return candidate;
        }
        const parent = dirname(candidate);
        if (parent === candidate) return null;
        candidate = parent;
    }
}

export function resolveRepoRoot({ env = process.env, startPath = currentWorkingDirectory(), moduleUrl } = {}) {
    if (env?.SOS_ROOT) return resolve(env.SOS_ROOT);
    const found = findSystemRoot(startPath);
    if (found) return found;
    const modulePath = moduleUrl
        ? (String(moduleUrl).startsWith('file:') ? fileURLToPath(moduleUrl) : moduleUrl)
        : fileURLToPath(import.meta.url);
    return dirname(dirname(dirname(modulePath)));
}
