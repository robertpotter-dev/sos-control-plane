import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { attachInstallHints, combineInstallCommands, detectPackageManager, installHint } from '../lib/doctor-install.mjs';

const SOURCE_ROOT = join(import.meta.dirname, '..', '..');

test('detectPackageManager prefers brew, winget, then apt', () => {
    assert.equal(detectPackageManager({ platform: 'darwin', hasCommand: name => name === 'brew' }).id, 'brew');
    assert.equal(detectPackageManager({
        platform: 'win32',
        hasCommand: name => name === 'winget' || name === 'scoop'
    }).id, 'winget');
    assert.equal(detectPackageManager({
        platform: 'win32',
        hasCommand: name => name === 'scoop'
    }).id, 'scoop');
    assert.equal(detectPackageManager({ platform: 'linux', hasCommand: name => name === 'apt-get' }).id, 'apt');
    assert.equal(detectPackageManager({ platform: 'linux', hasCommand: name => name === 'dnf' }).id, 'dnf');
    assert.equal(detectPackageManager({ platform: 'linux', hasCommand: () => false }).id, null);
});

test('installHint uses this OS package and never suggests Windows convert', () => {
    const brew = { id: 'brew', platform: 'darwin' };
    const winget = { id: 'winget', platform: 'win32' };
    const apt = { id: 'apt', platform: 'linux' };

    assert.equal(installHint('ffmpeg', brew).command, 'brew install ffmpeg');
    assert.equal(installHint('whisper-cli', brew).command, 'brew install whisper-cpp');
    assert.equal(installHint('HEIC/DNG decoder', brew).command, 'brew install ffmpeg');
    assert.equal(installHint('swift', brew).command, 'xcode-select --install');
    assert.equal(installHint('pdftotext', apt).command, 'sudo apt install poppler-utils');
    assert.equal(installHint('ffmpeg', winget).command, 'winget install --id Gyan.FFmpeg -e');
    assert.equal(installHint('tesseract', winget).command, 'winget install --id UB-Mannheim.TesseractOCR -e');
    assert.match(installHint('whisper-cli', apt).note, /whisper\.cpp/);
    assert.match(installHint('whisper-cli', winget).note, /scoop install whisper-cpp/);
    assert.equal(installHint('unrtf', apt, { missingNames: ['pandoc'] }).command, 'sudo apt install unrtf');
    assert.match(installHint('unrtf', apt, { missingNames: [] }).note, /pandoc already covers RTF/);
    assert.match(installHint('rsync', winget).note, /without rsync/);
    assert.equal(installHint('Repository root', brew), null);

    const windowsText = JSON.stringify([
        installHint('ffmpeg', winget),
        installHint('HEIC/DNG decoder', winget),
        installHint('tesseract', winget)
    ]);
    assert.doesNotMatch(windowsText, /(?<!ImageMagick\.)convert\b/);
});

test('combineInstallCommands dedupes ffmpeg for HEIC plus speech', () => {
    const brew = { id: 'brew', platform: 'darwin' };
    const commands = combineInstallCommands([
        installHint('ffmpeg', brew),
        installHint('HEIC/DNG decoder', brew),
        installHint('tesseract', brew),
        installHint('swift', brew),
        installHint('whisper-cli', brew)
    ]);
    assert.deepEqual(commands, [
        'brew install ffmpeg tesseract whisper-cpp',
        'xcode-select --install'
    ]);
});

test('attachInstallHints writes per-check text and a combined list', () => {
    const manager = { id: 'brew', platform: 'darwin' };
    const { checks, install, packageManager } = attachInstallHints([
        { name: 'ffmpeg', required: false, ok: false, detail: 'not found' },
        { name: 'node', required: true, ok: true, detail: '/usr/bin/node' },
        { name: 'Vault Target', required: false, ok: false, detail: 'missing' }
    ], { manager });
    assert.equal(packageManager.id, 'brew');
    assert.equal(checks[0].install, 'brew install ffmpeg');
    assert.equal(checks[1].install, null);
    assert.equal(checks[2].install, null);
    assert.deepEqual(install, ['brew install ffmpeg']);
});

test('sos doctor --json includes packageManager and install fields', () => {
    const result = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'sos.mjs'), 'doctor', '--json'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(typeof payload.ok, 'boolean');
    assert.ok(Array.isArray(payload.checks));
    assert.ok(Array.isArray(payload.install));
    assert.equal(typeof payload.packageManager.platform, 'string');
    for (const check of payload.checks) {
        assert.ok('install' in check);
        if (check.ok) assert.equal(check.install, null);
    }
});

test('sos help doctor says it prints install commands and does not install', () => {
    const result = spawnSync(process.execPath, [join(SOURCE_ROOT, '.sos', 'sos.mjs'), 'help', 'doctor'], {
        cwd: SOURCE_ROOT,
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /copy-paste install command/);
    assert.match(result.stdout, /does not install/);
});
