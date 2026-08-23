import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    statSync,
    utimesSync
} from 'fs';
import { join, relative } from 'path';

const DEFAULT_EXCLUDES = new Set(['.git', '.DS_Store', '.npm', '.cache']);

function isExcluded(relPath) {
    const parts = relPath.split(/[\\/]/).filter(Boolean);
    if (parts.some(part => DEFAULT_EXCLUDES.has(part))) return true;
    if (parts[0] === '.sos' && (parts[1] === 'cache' || parts[1] === 'runtime')) return true;
    return false;
}

function walkFiles(root, current = root, files = []) {
    if (!existsSync(current)) return files;
    for (const name of readdirSync(current)) {
        const path = join(current, name);
        const rel = relative(root, path);
        if (isExcluded(rel)) continue;
        const stat = statSync(path);
        if (stat.isDirectory()) walkFiles(root, path, files);
        else if (stat.isFile()) files.push(rel);
    }
    return files;
}

export function mirrorTree(sourceRoot, destRoot) {
    mkdirSync(destRoot, { recursive: true });
    const sourceFiles = new Set(walkFiles(sourceRoot));
    const destFiles = walkFiles(destRoot);

    for (const rel of destFiles) {
        if (sourceFiles.has(rel)) continue;
        rmSync(join(destRoot, rel), { force: true });
    }

    for (const rel of sourceFiles) {
        const from = join(sourceRoot, rel);
        const to = join(destRoot, rel);
        mkdirSync(join(to, '..'), { recursive: true });
        copyFileSync(from, to);
        const stat = statSync(from);
        utimesSync(to, stat.atime, stat.mtime);
    }

    return { copied: sourceFiles.size };
}
