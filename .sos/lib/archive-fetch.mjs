import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';

export const CONTROL_PLANE_ARCHIVE_URL = 'https://github.com/robertpotter-dev/sos-control-plane/archive/refs/heads/main.zip';

function commandExists(name) {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(probe, [name], { encoding: 'utf-8', stdio: 'pipe' }).status === 0;
}

export function downloadFile(url, destPath) {
    mkdirSync(dirname(destPath), { recursive: true });
    if (commandExists('curl')) {
        execFileSync('curl', ['-fsSL', url, '-o', destPath], { stdio: 'pipe' });
        return;
    }
    if (process.platform === 'win32') {
        execFileSync('powershell', [
            '-NoProfile',
            '-Command',
            `Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile '${destPath}'`
        ], { stdio: 'pipe' });
        return;
    }
    throw new Error('curl is required to download the published control plane. Install curl, or pass --path to a local copy.');
}

export function extractZip(zipPath, destDir) {
    mkdirSync(destDir, { recursive: true });
    if (commandExists('unzip')) {
        execFileSync('unzip', ['-q', zipPath, '-d', destDir], { stdio: 'pipe' });
        return;
    }
    if (process.platform === 'win32') {
        execFileSync('powershell', [
            '-NoProfile',
            '-Command',
            `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`
        ], { stdio: 'pipe' });
        return;
    }
    if (commandExists('python3')) {
        execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, destDir], { stdio: 'pipe' });
        return;
    }
    throw new Error('unzip is required to extract the published control plane, or pass --path to a local copy.');
}

export function findExtractedControlPlane(destDir) {
    const entries = readdirSync(destDir).filter(name => name !== 'control-plane.zip');
    for (const name of entries) {
        const path = join(destDir, name);
        if (statSync(path).isDirectory() && existsSync(join(path, 'AGENTS.md')) && existsSync(join(path, '.sos', 'sos.mjs'))) {
            return path;
        }
    }
    if (existsSync(join(destDir, 'AGENTS.md')) && existsSync(join(destDir, '.sos', 'sos.mjs'))) return destDir;
    throw new Error('Downloaded archive did not contain a Sovereign OS control plane.');
}

export function fetchPublishedControlPlane(tempDir) {
    const zipPath = join(tempDir, 'control-plane.zip');
    downloadFile(CONTROL_PLANE_ARCHIVE_URL, zipPath);
    extractZip(zipPath, tempDir);
    return findExtractedControlPlane(tempDir);
}
