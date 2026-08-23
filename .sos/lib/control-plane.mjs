import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';

export const CONTROL_PLANE_FILES = ['AGENTS.md', 'DEBRIEF.md', 'SETUP.md', 'package.json', '.gitignore', '.sos/sos.mjs'];
export const CONTROL_PLANE_DIRS = ['.sos/lib', '.sos/test', '.sos/vendor'];
export const KERNEL_PLUGIN_DIRS = ['apple-metal', 'linux', 'windows'];
export const CONTROL_PLANE_OBSOLETE = ['.tooling', 'bin', 'test', '.sos/plugins/linux-metal', '.sos/plugins/windows-metal'];
export const DEFAULT_CONTROL_PLANE_NAME = 'SOS Control Plane';
export const PRESERVE_ON_UPGRADE = ['.sos/config.json', '.sos/operator-preferences.json'];

export function defaultControlPlanePath(fromRoot) {
    return join(dirname(fromRoot), DEFAULT_CONTROL_PLANE_NAME);
}

export function readControlPlaneVersion(root) {
    const path = join(root, 'package.json');
    if (!existsSync(path)) return null;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
    } catch {
        return null;
    }
}

export function isControlPlaneRoot(root) {
    return CONTROL_PLANE_FILES.every(file => existsSync(join(root, file)))
        && CONTROL_PLANE_DIRS.every(dir => existsSync(join(root, dir)));
}

export function isSovereignInstance(root) {
    return existsSync(join(root, 'package.json')) && existsSync(join(root, '.sos', 'lib', 'domains.mjs'));
}

export function copyControlPlane({ source, dest, dryRun }) {
    const copied = [];
    const removed = [];
    for (const file of CONTROL_PLANE_FILES) {
        const from = join(source, file);
        if (!existsSync(from)) throw new Error('Missing control-plane file: ' + file);
        copied.push(file);
        if (!dryRun) {
            mkdirSync(dirname(join(dest, file)), { recursive: true });
            cpSync(from, join(dest, file));
        }
    }
    for (const dir of CONTROL_PLANE_DIRS) {
        const from = join(source, dir);
        if (!existsSync(from)) throw new Error('Missing control-plane directory: ' + dir);
        copied.push(dir + '/');
        if (!dryRun) {
            const target = join(dest, dir);
            rmSync(target, { recursive: true, force: true });
            mkdirSync(dirname(target), { recursive: true });
            cpSync(from, target, {
                recursive: true,
                filter: src => basename(src) !== '.DS_Store'
            });
        }
    }
    for (const plugin of KERNEL_PLUGIN_DIRS) {
        const from = join(source, '.sos', 'plugins', plugin);
        if (!existsSync(from)) continue;
        copied.push(`.sos/plugins/${plugin}/`);
        if (!dryRun) {
            const target = join(dest, '.sos', 'plugins', plugin);
            rmSync(target, { recursive: true, force: true });
            mkdirSync(dirname(target), { recursive: true });
            cpSync(from, target, {
                recursive: true,
                filter: src => basename(src) !== '.DS_Store'
            });
        }
    }
    for (const obsolete of CONTROL_PLANE_OBSOLETE) {
        const target = join(dest, obsolete);
        if (!existsSync(target)) continue;
        removed.push(obsolete);
        if (!dryRun) rmSync(target, { recursive: true, force: true });
    }
    return { copied, removed };
}
