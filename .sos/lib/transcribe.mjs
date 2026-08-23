import { execFileSync, execSync } from 'child_process';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync
} from 'fs';
import os from 'os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

import { discoverDomains, REPO_ROOT } from './domains.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { allocateDuplicateArchivePath, archiveMatchesSource, findAssetBySourceSha256, readSourceSha256, recordSha256InJson, sha256File } from './hash.mjs';
import { commandExists, findWhisperCli } from './tools.mjs';
import { formatKeyframeVisionSection, runKeyframeVision } from './vision.mjs';

const __filename = fileURLToPath(import.meta.url);

const HOME = os.homedir();
const MODEL_DIR = join(HOME, '.cache', 'whisper-cpp');
const DEFAULT_MODEL = 'ggml-base.en.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_MODEL}`;
const MODEL_PATH = join(MODEL_DIR, DEFAULT_MODEL);

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'];

function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function ensureModel() {
    if (existsSync(MODEL_PATH)) return;
    console.log(`Downloading Whisper base model (~140MB) to ${MODEL_PATH}...`);
    mkdirSync(MODEL_DIR, { recursive: true });
    if (commandExists('curl')) {
        execFileSync('curl', ['-fsSL', '-o', MODEL_PATH, MODEL_URL], { stdio: 'inherit' });
        return;
    }
    throw new Error('curl is required to download the Whisper model, or place ggml-base.en.bin in ~/.cache/whisper-cpp/.');
}

function convertToWav(absInput, tempWav, ext) {
    if (ext === '.wav') {
        copyFileSync(absInput, tempWav);
        return;
    }
    if (process.platform === 'darwin' && commandExists('afconvert')) {
        execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', absInput, tempWav], { stdio: 'pipe' });
        return;
    }
    if (!commandExists('ffmpeg')) {
        throw new Error('ffmpeg is required to convert audio or video on this platform. Install ffmpeg, or use sos ingest --frontier.');
    }
    execFileSync('ffmpeg', ['-y', '-i', absInput, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tempWav], { stdio: 'pipe' });
}

function extractKeyframe(videoPath, targetAssetPath) {
    const targetDir = dirname(targetAssetPath);
    mkdirSync(targetDir, { recursive: true });

    if (process.platform === 'darwin') {
        try {
            const tempThumbDir = join(os.tmpdir(), `ql_thumb_${Date.now()}`);
            mkdirSync(tempThumbDir, { recursive: true });
            execSync(`qlmanage -t -s 1280 -o "${tempThumbDir}" "${videoPath}"`, { stdio: 'pipe' });
            const generatedPng = join(tempThumbDir, `${basename(videoPath)}.png`);
            if (existsSync(generatedPng)) {
                execSync(`sips -s format jpeg -s formatOptions 85 "${generatedPng}" --out "${targetAssetPath}"`, { stdio: 'pipe' });
                unlinkSync(generatedPng);
                console.log(`Extracted hero keyframe: ${targetAssetPath}`);
                return true;
            }
        } catch (error) {
            console.warn(`Quick Look keyframe failed: ${error.message}`);
        }
    }

    if (commandExists('ffmpeg')) {
        try {
            execFileSync('ffmpeg', ['-y', '-ss', '1', '-i', videoPath, '-frames:v', '1', targetAssetPath], { stdio: 'pipe' });
            if (existsSync(targetAssetPath)) {
                console.log(`Extracted hero keyframe: ${targetAssetPath}`);
                return true;
            }
        } catch (error) {
            console.warn(`Could not extract keyframe: ${error.message}`);
        }
    }
    return false;
}

export function transcribe(inputFile, targetDir = null, requestedDomain = null, options = {}) {
    const absInput = resolve(inputFile);
    if (!existsSync(absInput)) {
        throw new Error(`File not found: ${absInput}`);
    }

    const dryRun = options.dryRun === true;

    const ext = extname(absInput).toLowerCase();
    const isVideo = VIDEO_EXTENSIONS.includes(ext);
    const baseName = basename(absInput, ext);
    const baseSlug = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const tempWav = join(os.tmpdir(), `whisper_${Date.now()}.wav`);

    // 2. Resolve the domain from an explicit ingest route or the repository path.
    const domains = discoverDomains();
    const domain = requestedDomain
        ? domains.find(candidate => candidate.name === requestedDomain)
        : domains.find(candidate => absInput === candidate.path || absInput.startsWith(`${candidate.path}${sep}`));
    if (!domain) {
        throw new Error(`Cannot resolve a domain for ${absInput}. Pass --domain <name>.`);
    }
    const domainName = domain.name;
    const parentNode = parseFrontmatter(readFileSync(domain.spaceFile, 'utf-8'))?.id || `${domain.prefix}:charter`;
    const domainPrefix = parentNode.split(':')[0];

    const assetDir = targetDir ? resolve(targetDir) : join(REPO_ROOT, domainName, 'assets');
    if (!dryRun) mkdirSync(assetDir, { recursive: true });

    const archiveRoot = join(REPO_ROOT, domainName, 'inbox', 'archive');
    const requestedArchivePath = options.archiveRelativePath
        ? options.archiveRelativePath.replace(/^\.\.([/\\]|$)/, '').split('\\').join('/')
        : null;
    const archiveDir = requestedArchivePath
        ? join(archiveRoot, dirname(requestedArchivePath))
        : archiveRoot;
    const archiveFilename = requestedArchivePath ? basename(requestedArchivePath) : basename(absInput);
    if (!dryRun) mkdirSync(archiveDir, { recursive: true });

    const isForce = options.force === true || process.argv.includes('--force') || process.argv.includes('--overwrite');
    const sourceSha256 = sha256File(absInput);
    let slug = baseSlug;
    let finalMdPath = join(assetDir, `transcript-${slug}.md`);
    let jsonTelemetryPath = join(archiveDir, `transcript-${slug}.json`);
    let archivePath = join(archiveDir, archiveFilename);

    function preserveDuplicate(existingTranscript) {
        console.log(`\n🛡️ [DEDUPLICATION SAFEGUARD]`);
        console.log(`  SHA-256 match: ${sourceSha256}`);
        console.log(`  Existing Transcript (Tier 2): ${existingTranscript}`);
        console.log(`  Skipping redundant Whisper run to conserve compute.`);

        let retainedArchivePath = archivePath;
        const absInputPosix = absInput.split(sep).join('/');
        if (absInputPosix.includes('/inbox/') && !absInputPosix.includes('/inbox/archive/')) {
            retainedArchivePath = allocateDuplicateArchivePath(archiveDir, baseName, ext);
            if (dryRun) {
                console.log(`  DRY Preserve duplicate source -> ${retainedArchivePath}`);
            } else {
                mkdirSync(archiveDir, { recursive: true });
                renameSync(absInput, retainedArchivePath);
                console.log(`  📦 Preserved duplicate source: ${retainedArchivePath}\n`);
            }
        }
        return {
            archivePath: retainedArchivePath,
            deduplicated: true,
            domain: domainName,
            isVideo,
            keyframePath: isVideo ? join(assetDir, `keyframe-${slug}.jpg`) : null,
            sourcePath: absInput,
            sourceSha256,
            transcriptPath: existingTranscript
        };
    }

    const hashedAsset = findAssetBySourceSha256(assetDir, sourceSha256, { type: 'transcript' });
    if (hashedAsset && !isForce) return preserveDuplicate(hashedAsset);

    function allocateCollisionPaths() {
        let counter = 2;
        while (
            existsSync(join(assetDir, `transcript-${baseSlug}-${counter}.md`))
            || existsSync(join(archiveDir, `transcript-${baseSlug}-${counter}.json`))
            || existsSync(join(archiveDir, `${baseName}-${counter}${ext}`))
        ) {
            counter++;
        }
        slug = `${baseSlug}-${counter}`;
        finalMdPath = join(assetDir, `transcript-${slug}.md`);
        jsonTelemetryPath = join(archiveDir, `transcript-${slug}.json`);
        archivePath = join(archiveDir, `${baseName}-${counter}${ext}`);
        console.log(`\n⚠️ [COLLISION PREVENTION] Different media with name '${baseName}' detected.`);
        console.log(`   Allocated safe non-destructive identifier: transcript-${slug}.md`);
    }

    if (existsSync(finalMdPath) && existsSync(archivePath) && !isForce) {
        if (!readSourceSha256(readFileSync(finalMdPath, 'utf-8')) && archiveMatchesSource(archivePath, absInput, sourceSha256)) {
            return preserveDuplicate(finalMdPath);
        }
        allocateCollisionPaths();
    } else if (existsSync(archivePath) || existsSync(jsonTelemetryPath)) {
        allocateCollisionPaths();
    }

    const plannedResult = {
        archivePath,
        deduplicated: false,
        domain: domainName,
        isVideo,
        keyframePath: isVideo ? join(assetDir, `keyframe-${slug}.jpg`) : null,
        sourcePath: absInput,
        sourceSha256,
        transcriptPath: finalMdPath
    };

    if (dryRun) {
        console.log(`  DRY Local Whisper [${domainName}]: ${basename(absInput)}`);
        console.log(`  DRY Transcript -> ${finalMdPath}`);
        if (isVideo) console.log(`  DRY Keyframe -> ${plannedResult.keyframePath}`);
        console.log(`  DRY Archive source -> ${archivePath}`);
        return plannedResult;
    }

    const whisperBin = findWhisperCli();
    if (!whisperBin) {
        throw new Error('whisper-cli is required for speech. Install whisper.cpp and put whisper-cli on PATH, or use sos ingest --frontier.');
    }
    ensureModel();

    console.log(`\nIngesting media (${isVideo ? 'Video' : 'Audio'}): ${basename(absInput)}`);
    convertToWav(absInput, tempWav, ext);

    let keyframeRelPath = null;
    if (isVideo) {
        const keyframeFilename = `keyframe-${slug}.jpg`;
        const keyframeAbsPath = join(assetDir, keyframeFilename);
        if (extractKeyframe(absInput, keyframeAbsPath)) {
            keyframeRelPath = keyframeFilename;
        }
    }

    const outputBase = join(os.tmpdir(), `whisper_out_${Date.now()}`);
    console.log(`Transcribing with ${whisperBin}...`);
    execFileSync(whisperBin, ['-m', MODEL_PATH, '-f', tempWav, '-otxt', '-oj', '-of', outputBase], { stdio: 'pipe' });

    // 6. Save Tier 3 Raw Machine JSON Telemetry
    const rawJsonPath = `${outputBase}.json`;
    if (existsSync(rawJsonPath)) {
        renameSync(rawJsonPath, jsonTelemetryPath);
        recordSha256InJson(jsonTelemetryPath, sourceSha256);
        console.log(`📊 Generated Machine JSON (Tier 3): ${jsonTelemetryPath}`);
    }

    // 7. Reconstruct prose for Tier 2 Markdown Manifest
    const rawTxtPath = `${outputBase}.txt`;
    let rawText = '';
    if (existsSync(rawTxtPath)) {
        rawText = readFileSync(rawTxtPath, 'utf-8').trim();
        unlinkSync(rawTxtPath);
    }

    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
    const paragraphs = [];
    let currentPara = [];

    for (const line of lines) {
        if (line.startsWith('-') || line.startsWith('[')) {
            if (currentPara.length > 0) {
                paragraphs.push(currentPara.join(' '));
                currentPara = [];
            }
            currentPara.push(line);
        } else {
            currentPara.push(line);
            if ((line.endsWith('.') || line.endsWith('?') || line.endsWith('!')) && currentPara.join(' ').length > 350) {
                paragraphs.push(currentPara.join(' '));
                currentPara = [];
            }
        }
    }
    if (currentPara.length > 0) {
        paragraphs.push(currentPara.join(' '));
    }
    const cleanBody = paragraphs.join('\n\n');

    const cleanTitle = baseName.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const dateStr = localDateString();

    let keyframeVisionSection = '';
    if (isVideo && keyframeRelPath) {
        const keyframeVisionJsonPath = join(archiveDir, `keyframe-${slug}-vision-telemetry.json`);
        try {
            if (dryRun) {
                keyframeVisionSection = [
                    '## Keyframe Vision Telemetry',
                    '',
                    `[Dry run: keyframe OCR/telemetry would be written to keyframe-${slug}-vision-telemetry.json]`,
                    ''
                ].join('\n');
            } else {
                const telemetry = runKeyframeVision(join(assetDir, keyframeRelPath), {
                    domainName,
                    jsonOutputPath: keyframeVisionJsonPath
                });
                keyframeVisionSection = formatKeyframeVisionSection(telemetry, {
                    transcriptPath: finalMdPath,
                    jsonOutputPath: keyframeVisionJsonPath,
                    keyframeRelPath
                });
                console.log(`👁️ Generated Keyframe Vision (Tier 3): ${keyframeVisionJsonPath}`);
            }
        } catch (error) {
            console.warn(`⚠️ Warning: Keyframe vision telemetry skipped: ${error.stack}`);
            keyframeVisionSection = keyframeRelPath
                ? `\n![Hero Keyframe](${keyframeRelPath})\n`
                : '';
        }
    }

    const archiveLink = relative(dirname(finalMdPath), archivePath).split('\\').join('/');
    const telemetryLink = relative(dirname(finalMdPath), jsonTelemetryPath).split('\\').join('/');
    const mdContent = `---
id: "${domainPrefix}:transcript-${slug}"
parent: "${parentNode}"
related: []
title: "Transcript: ${cleanTitle}"
description: "Full-text verbatim transcript of ${basename(absInput)}."
type: "transcript"
domain: "${domainName}"
exposure: "${domain.exposure}"
status: "active"
created: ${dateStr}
updated: ${dateStr}
source_sha256: "${sourceSha256}"
tags: ["${domainName}", "transcript", "assets", "${isVideo ? 'video' : 'audio'}"]
---

# Transcript: ${cleanTitle}

**Source Media:** [${basename(archivePath)}](${archiveLink})
**Raw JSON Telemetry (Tier 3):** [transcript-${slug}.json](${telemetryLink})
**Media Type:** ${isVideo ? 'Video (.mp4)' : 'Audio (.m4a)'}
**Date Processed:** ${dateStr}

---

${keyframeVisionSection}${keyframeVisionSection ? '\n---\n\n' : ''}## Verbatim Dialogue

${cleanBody}
`;

    writeFileSync(finalMdPath, mdContent, 'utf-8');

    if (existsSync(tempWav)) unlinkSync(tempWav);

    // Archive-Move Invariant: Move raw source media to inbox/archive if not already there
    const absInputPosixFinal = absInput.split(sep).join('/');
    if (absInputPosixFinal.includes('/inbox/') && !absInputPosixFinal.includes('/inbox/archive/')) {
        renameSync(absInput, archivePath);
        console.log(`📦 Archived source media:       ${archivePath}`);
    }

    console.log(`\n✅ Media Ingestion complete!`);
    console.log(`📄 Generated Transcript (Tier 2): ${finalMdPath}`);
    if (keyframeRelPath) console.log(`🖼️ Generated Keyframe (Tier 2):   ${join(assetDir, keyframeRelPath)}`);
    return { ...plannedResult, keyframePath: keyframeRelPath ? join(assetDir, keyframeRelPath) : null };
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.log(`Usage: node .sos/lib/transcribe.mjs <media-file> [--domain <name>] [--out <output-dir>] [--dry-run] [--force]`);
        process.exit(1);
    }

    const inputFile = args[0];
    let targetDir = null;
    let requestedDomain = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--out' && args[i + 1]) {
            targetDir = args[i + 1];
        } else if (args[i] === '--domain' && args[i + 1]) {
            requestedDomain = args[i + 1];
        }
    }

    try {
        transcribe(inputFile, targetDir, requestedDomain, {
            dryRun: args.includes('--dry-run'),
            force: args.includes('--force') || args.includes('--overwrite')
        });
    } catch (error) {
        console.error(`Error: ${error.stack}`);
        process.exitCode = 1;
    }
}
