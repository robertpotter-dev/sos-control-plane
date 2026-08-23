#!/usr/bin/env node

import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

import { discoverDomains, REPO_ROOT } from './domains.mjs';
import { ui } from './terminal.mjs';

function parseArguments() {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const unknown = args.filter(arg => arg.startsWith('--') && !['--dry-run', '--domain', '--json'].includes(arg));
    if (unknown.length) throw new Error('Unknown option: ' + unknown.join(', '));

    let domain = null;
    const positional = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--domain') {
            domain = args[++index];
            if (!domain) throw new Error('--domain requires a domain name.');
        } else if (arg === '--dry-run' || arg === '--json') {
            continue;
        } else {
            positional.push(arg);
        }
    }

    if (positional.length !== 1) {
        throw new Error('Expected one URL. Example: sos fetch "https://www.youtube.com/watch?v=..." --domain personal');
    }

    return { url: positional[0], domain, dryRun: args.includes('--dry-run'), json };
}

export function filenameFromTitle(title, uploader = '') {
    const primary = String(title ?? '').replace(/[\u0000-\u001f]/g, '').replace(/[\/\\:]/g, '-').replace(/\s+/g, ' ').trim();
    const channel = String(uploader ?? '').replace(/[\u0000-\u001f]/g, '').replace(/[\/\\:]/g, '-').replace(/\s+/g, ' ').trim();
    const combined = channel && primary && channel.toLowerCase() !== primary.toLowerCase()
        ? `${primary} — ${channel}`
        : primary;
    return combined.slice(0, 180) || 'remote-video';
}

export function resolveFetchDomain(requestedDomain) {
    const domains = discoverDomains();
    if (requestedDomain) {
        const match = domains.find(domain => domain.name === requestedDomain);
        if (!match) throw new Error(`Unknown domain: ${requestedDomain}`);
        return match;
    }
    if (domains.length === 1) return domains[0];
    throw new Error(`--domain is required when multiple domains exist: ${domains.map(domain => domain.name).join(', ')}`);
}

export function validateFetchUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid URL: ${url}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`URL must use http or https: ${url}`);
    }
    return parsed;
}

export function allocateInboxTarget(domain, stem, extension) {
    const inboxDir = join(domain.path, 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    const safeStem = filenameFromTitle(stem);
    let filename = `${safeStem}${extension}`;
    let target = join(inboxDir, filename);
    for (let counter = 2; existsSync(target); counter++) {
        filename = `${safeStem} ${counter}${extension}`;
        target = join(inboxDir, filename);
    }
    return { inboxDir, filename, target };
}

function commandExists(name) {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(probe, [name], { encoding: 'utf-8', stdio: 'pipe' }).status === 0;
}

export function ensureYtDlp() {
    if (!commandExists('yt-dlp')) {
        throw new Error('yt-dlp is required for sos fetch. Install yt-dlp from https://github.com/yt-dlp/yt-dlp.');
    }
    return 'yt-dlp';
}

export function hasFfmpeg() {
    return commandExists('ffmpeg');
}

export function buildYtDlpArgs(url, extraArgs = []) {
    const args = ['--no-playlist', ...extraArgs];
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    if (hostname === 'youtube.com' || hostname === 'youtu.be' || hostname.endsWith('.youtube.com')) {
        args.push('--extractor-args', 'youtube:player_client=android,web');
    }
    if (hasFfmpeg()) {
        args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
    } else {
        args.push('-f', 'best[ext=mp4]/best');
    }
    args.push(url);
    return args;
}

export function fetchDownloadOptions(json) {
    return json
        ? { extraArgs: ['--no-progress', '--quiet'], stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8' }
        : { extraArgs: [], stdio: 'inherit' };
}

function runYtDlpDownload(ytDlp, args, json) {
    const io = fetchDownloadOptions(json);
    if (!json) {
        execFileSync(ytDlp, args, { stdio: io.stdio, cwd: REPO_ROOT });
        return;
    }
    const result = spawnSync(ytDlp, args, {
        cwd: REPO_ROOT,
        encoding: io.encoding,
        stdio: io.stdio
    });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) {
        const detail = String(result.stderr || result.stdout || '').trim();
        throw new Error(detail || `yt-dlp exited with status ${result.status ?? 1}`);
    }
}

function writeQuietSourceMetadata(targetPath, url, title) {
    spawnSync('xattr', ['-w', 'sos.source-url', url, targetPath], { stdio: 'ignore' });
    spawnSync('xattr', ['-w', 'sos.source-title', title, targetPath], { stdio: 'ignore' });
}

export function fetchRemoteVideo(url, options = {}) {
    const parsedUrl = validateFetchUrl(url);
    const domain = resolveFetchDomain(options.domain);
    const ytDlp = ensureYtDlp();
    const dryRun = options.dryRun === true;

    if (!hasFfmpeg() && options.json !== true) {
        console.warn(ui.warning('ffmpeg not found — install ffmpeg to merge separate video and audio streams.'));
    }

    const probe = execFileSync(ytDlp, buildYtDlpArgs(parsedUrl.toString(), [
        '--print', '%(title)s',
        '--print', '%(id)s',
        '--print', '%(ext)s',
        '--print', '%(uploader)s'
    ]), { encoding: 'utf-8' }).trim().split('\n');

    const [title, id, ext, uploader] = probe;
    if (!title || !id || !ext) {
        throw new Error(`Could not resolve remote media metadata for ${url}`);
    }

    const stem = filenameFromTitle(title, uploader);
    const extension = ext.startsWith('.') ? ext : `.${ext}`;
    const { target, filename } = allocateInboxTarget(domain, stem, extension);

    if (dryRun) {
        return {
            dryRun: true,
            url: parsedUrl.toString(),
            domain: domain.name,
            target,
            filename,
            metadata: { title, id, uploader, ext: extension }
        };
    }

    const download = fetchDownloadOptions(options.json === true);
    runYtDlpDownload(ytDlp, buildYtDlpArgs(parsedUrl.toString(), [
        '--no-overwrites',
        '-o', target,
        ...download.extraArgs
    ]), options.json === true);

    if (!existsSync(target)) {
        throw new Error(`Download completed but file not found: ${target}`);
    }

    writeQuietSourceMetadata(target, parsedUrl.toString(), title);

    return {
        url: parsedUrl.toString(),
        domain: domain.name,
        target,
        filename,
        metadata: { title, id, uploader, ext: extension }
    };
}

async function main() {
    let options;
    try {
        options = parseArguments();
    } catch (error) {
        if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: error.stack }, null, 2));
        else console.error(ui.error('Error: ' + error.stack));
        process.exitCode = 1;
        return;
    }

    try {
        const result = fetchRemoteVideo(options.url, options);
        const capture = relative(REPO_ROOT, result.target);
        if (options.json) {
            console.log(JSON.stringify({
                ok: true,
                dryRun: Boolean(result.dryRun),
                url: result.url,
                domain: result.domain,
                path: capture,
                filename: result.filename,
                metadata: result.metadata
            }, null, 2));
            return;
        }
        if (result.dryRun) {
            console.log(ui.warning('Dry run — remote fetch planned:'));
            console.log(`  Domain:   ${ui.command(result.domain)}`);
            console.log(`  Inbox:    ${ui.muted(capture)}`);
            return;
        }

        console.log(ui.success('Remote media fetched to inbox.'));
        console.log(`  Domain:   ${ui.command(result.domain)}`);
        console.log(`  Capture:  ${ui.muted(capture)}`);
        console.log(`  Next:     ${ui.command(`sos ingest "${capture}"`)}`);
    } catch (error) {
        if (options.json) console.log(JSON.stringify({ ok: false, error: error.stack }, null, 2));
        else console.error(ui.error('Error: ' + error.stack));
        process.exitCode = 1;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
