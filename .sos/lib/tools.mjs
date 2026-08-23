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
