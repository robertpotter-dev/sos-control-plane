import { execFileSync, spawnSync } from 'child_process';

export function commandExists(name) {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(probe, [name], { encoding: 'utf-8', stdio: 'pipe' }).status === 0;
}

export function firstCommand(names) {
    return names.find(name => commandExists(name)) || null;
}

export function runTool(command, args, options = {}) {
    return execFileSync(command, args, {
        encoding: 'utf-8',
        stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
        maxBuffer: options.maxBuffer || 16 * 1024 * 1024
    });
}

export function findWhisperCli() {
    return firstCommand(['whisper-cli', 'whisper-cpp', 'whisper']);
}

// On Windows, `convert.exe` is the built-in FAT-to-NTFS filesystem converter, not ImageMagick.
// Only trust the bare `convert` name as an ImageMagick alias off Windows.
export function heicDecoderCandidates() {
    return process.platform === 'win32'
        ? ['magick', 'heif-convert', 'ffmpeg']
        : ['magick', 'convert', 'heif-convert', 'ffmpeg'];
}
