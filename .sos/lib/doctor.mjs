import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { fail } from './cli.mjs';
import { attachInstallHints, detectPackageManager } from './doctor-install.mjs';
import { resolvedVaults } from './system-config.mjs';
import { ui } from './terminal.mjs';
import { firstCommand, heicDecoderCandidates } from './tools.mjs';

function toolCheck(name, required = false) {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'where' : 'which';
    const result = spawnSync(cmd, [name], { encoding: 'utf-8' });
    return { name, required, ok: result.status === 0, path: result.status === 0 ? result.stdout.trim() : null };
}

function whisperToolCheck() {
    const found = firstCommand(['whisper-cli', 'whisper-cpp', 'whisper']);
    return { name: 'whisper-cli', required: false, ok: Boolean(found), path: found };
}

function heicDecoderCheck() {
    const found = firstCommand(heicDecoderCandidates());
    return { name: 'HEIC/DNG decoder', required: false, ok: Boolean(found), path: found };
}

function sensorNotes(isMac) {
    if (isMac) {
        return [
            'Images: Apple Vision via apple-metal (Swift) when the SDK is compatible. Best local fit on this hardware.',
            'Speech: whisper-cli with afconvert or ffmpeg.',
            'PDF: Swift PDFKit. RTF: textutil.'
        ];
    }
    return [
        'Images: Tesseract or Windows OCR for text in pictures. No Apple Vision scene tags. Empty OCR is still a successful photo ingest.',
        'HEIC/AVIF/DNG: decode with ffmpeg, ImageMagick (magick), or heif-convert before OCR.',
        'Speech: whisper-cli (or whisper-cpp) plus ffmpeg, except for .wav files.',
        'PDF: pdftotext from poppler. RTF: pandoc or unrtf.'
    ];
}

export function doctorCommand(args, options, ctx) {
    const { repoRoot, discoverDomains } = ctx;
    if (args.length > 0) return fail(`doctor does not accept arguments: ${args.join(' ')}`, options);
    if (options.dryRun) return fail('--dry-run is not applicable to the read-only doctor command.', options);

    const domains = discoverDomains();
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    const tools = [
        toolCheck('node', true),
        toolCheck('git'),
        isMac ? toolCheck('textutil') : null,
        isMac ? toolCheck('sips') : null,
        isMac ? toolCheck('swift') : null,
        isWin ? toolCheck('powershell', true) : null,
        whisperToolCheck(),
        isMac ? toolCheck('afconvert') : null,
        toolCheck('tesseract'),
        isMac ? null : toolCheck('pandoc'),
        isMac ? null : toolCheck('unrtf'),
        toolCheck('pdftotext'),
        heicDecoderCheck(),
        toolCheck('rsync'),
        toolCheck('curl'),
        toolCheck('yt-dlp'),
        toolCheck('ffmpeg')
    ].filter(Boolean);
    const checks = [
        { name: 'Repository root', required: true, ok: existsSync(join(repoRoot, 'package.json')), detail: repoRoot },
        { name: 'Domain charters', required: true, ok: domains.length > 0, detail: `${domains.length} discovered` },
        ...resolvedVaults(repoRoot).map(vault => ({
            name: 'Vault Target', required: false, ok: existsSync(vault), detail: vault
        })),
        ...tools.map(tool => ({ name: tool.name, required: tool.required, ok: tool.ok, detail: tool.path ?? 'not found' }))
    ];

    const swift = tools.find(tool => tool.name === 'swift');
    if (swift?.ok) {
        const compilerResult = spawnSync('swift', ['--version'], { encoding: 'utf-8' });
        const compilerText = `${compilerResult.stdout ?? ''}\n${compilerResult.stderr ?? ''}`;
        const compilerVersion = compilerText.match(/Apple Swift version\s+([^\s]+)/)?.[1] ?? null;
        const sdkResult = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf-8' });
        const sdkRoot = sdkResult.status === 0 ? sdkResult.stdout.trim() : null;
        const interfaceCandidates = sdkRoot ? [
            join(sdkRoot, 'usr/lib/swift/Swift.swiftmodule/arm64e-apple-macos.swiftinterface'),
            join(sdkRoot, 'usr/lib/swift/Swift.swiftmodule/arm64-apple-macos.swiftinterface'),
            join(sdkRoot, 'usr/lib/swift/Swift.swiftmodule/x86_64-apple-macos.swiftinterface')
        ] : [];
        const interfacePath = interfaceCandidates.find(candidate => existsSync(candidate));
        const sdkVersion = interfacePath
            ? readFileSync(interfacePath, 'utf-8').match(/swift-compiler-version:\s+Apple Swift version\s+([^\s]+)/)?.[1] ?? null
            : null;
        const compatible = Boolean(compilerVersion && sdkVersion && compilerVersion === sdkVersion);
        checks.push({
            name: 'Swift SDK compatibility',
            required: false,
            ok: compatible,
            detail: compilerVersion && sdkVersion
                ? `compiler ${compilerVersion}; SDK ${sdkVersion}`
                : 'could not determine compiler and SDK versions'
        });
    }

    const requiredFailures = checks.filter(check => check.required && !check.ok);
    const warnings = checks.filter(check => !check.required && !check.ok);
    const notes = sensorNotes(isMac);
    const manager = detectPackageManager();
    const hinted = attachInstallHints(checks, { manager });
    const result = {
        ok: requiredFailures.length === 0,
        requiredFailures: requiredFailures.length,
        warnings: warnings.length,
        checks: hinted.checks,
        notes,
        packageManager: hinted.packageManager,
        install: hinted.install
    };

    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (!options.quiet) {
        console.log(ui.accent('Sovereign OS doctor'));
        for (const check of hinted.checks) {
            const marker = check.ok ? 'OK' : check.required ? 'FAIL' : 'WARN';
            const color = check.ok ? ui.success : check.required ? ui.error : ui.warning;
            console.log(`  ${color(marker.padEnd(4))} ${check.name}: ${ui.muted(check.detail)}`);
            if (!check.ok && check.install) console.log(`        ${ui.muted(check.install)}`);
        }
        console.log(`\n${ui.accent('Sensor notes')}`);
        for (const note of notes) console.log(`  ${ui.muted(note)}`);
        if (hinted.install.length) {
            console.log(`\n${ui.accent('Install missing tools')}`);
            console.log(`  ${ui.muted('Copy and run. Doctor does not install.')}`);
            for (const command of hinted.install) console.log(`  ${command}`);
        } else if (warnings.length && manager.hint) {
            console.log(`\n${ui.accent('Install missing tools')}`);
            console.log(`  ${ui.muted(manager.hint)}`);
        }
        const summary = `${result.ok ? 'Core control plane is ready.' : 'Core control plane has required failures.'}${warnings.length ? ` ${warnings.length} optional capability warning(s).` : ''}`;
        console.log(`\n${result.ok ? ui.success(summary) : ui.error(summary)}`);
    }
    if (!result.ok) process.exitCode = 1;
}
