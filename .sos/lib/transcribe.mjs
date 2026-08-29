import { execFileSync } from 'child_process';
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
import { allocateDuplicateArchivePath, archiveMatchesSource, findAssetBySourceSha256, readSourceSha256, sha256File } from './hash.mjs';
import { readJsonRecords, writeJsonl } from './jsonl.mjs';
import { ui } from './terminal.mjs';
import { commandExists, findWhisperCli } from './tools.mjs';

const __filename = fileURLToPath(import.meta.url);

const HOME = os.homedir();
const MODEL_DIR = join(HOME, '.cache', 'whisper-cpp');
const DEFAULT_MODEL = 'ggml-base.en.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_MODEL}`;
const MODEL_PATH = join(MODEL_DIR, DEFAULT_MODEL);

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'];

export function mediaTitle(baseName) {
    return String(baseName).replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase()).trim();
}

export function normalizeWhisperSegments(telemetry, { sourceSha256, sourceFile }) {
    const language = telemetry.result?.language || telemetry.params?.language || null;
    const model = basename(telemetry.params?.model || DEFAULT_MODEL);
    return (telemetry.transcription || []).map((segment, index) => ({
        record_id: `whisper:${sourceSha256.slice(0, 16)}:${String(index + 1).padStart(6, '0')}`,
        source_file: sourceFile,
        source_sha256: sourceSha256,
        segment_index: index,
        index_line: index + 1,
        start_ms: segment.offsets?.from ?? null,
        end_ms: segment.offsets?.to ?? null,
        start_timestamp: segment.timestamps?.from ?? null,
        end_timestamp: segment.timestamps?.to ?? null,
        text: String(segment.text || '').trim(),
        engine: 'whisper.cpp',
        model,
        language
    }));
}

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
        throw new Error('ffmpeg is required to convert audio or video on this platform. The source remains in inbox; install ffmpeg or provide a local sensor plugin, then ingest again.');
    }
    execFileSync('ffmpeg', ['-y', '-i', absInput, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tempWav], { stdio: 'pipe' });
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
    const parentNode = `${domain.prefix}:charter`;
    const domainPrefix = domain.prefix;

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
    let segmentIndexPath = join(assetDir, `transcript-${slug}.segments.jsonl`);
    let archivePath = join(archiveDir, archiveFilename);

    function preserveDuplicate(existingTranscript) {
        console.log(`\n${ui.warning('DEDUPLICATION SAFEGUARD')}`);
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
                console.log(`  Preserved duplicate source: ${retainedArchivePath}\n`);
            }
        }
        const existingIndex = join(dirname(existingTranscript), `${basename(existingTranscript, '.md')}.segments.jsonl`);
        let recordCount = 0;
        if (existsSync(existingIndex)) {
            try {
                recordCount = readJsonRecords(existingIndex).length;
            } catch {}
        }
        return {
            archivePath: retainedArchivePath,
            deduplicated: true,
            domain: domainName,
            isVideo,
            segmentIndexPath: existsSync(existingIndex) ? existingIndex : null,
            recordCount,
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
            || existsSync(join(assetDir, `transcript-${baseSlug}-${counter}.segments.jsonl`))
            || existsSync(join(archiveDir, `${baseName}-${counter}${ext}`))
        ) {
            counter++;
        }
        slug = `${baseSlug}-${counter}`;
        finalMdPath = join(assetDir, `transcript-${slug}.md`);
        segmentIndexPath = join(assetDir, `transcript-${slug}.segments.jsonl`);
        archivePath = join(archiveDir, `${baseName}-${counter}${ext}`);
        console.log(`\n${ui.warning('COLLISION PREVENTION')} Different media with name '${baseName}' detected.`);
        console.log(`   Allocated safe non-destructive identifier: transcript-${slug}.md`);
    }

    if (existsSync(finalMdPath) && existsSync(archivePath) && !isForce) {
        if (!readSourceSha256(readFileSync(finalMdPath, 'utf-8')) && archiveMatchesSource(archivePath, absInput, sourceSha256)) {
            return preserveDuplicate(finalMdPath);
        }
        allocateCollisionPaths();
    } else if (existsSync(archivePath) || existsSync(segmentIndexPath)) {
        allocateCollisionPaths();
    }

    const plannedResult = {
        archivePath,
        deduplicated: false,
        domain: domainName,
        isVideo,
        segmentIndexPath,
        recordCount: 0,
        sourcePath: absInput,
        sourceSha256,
        transcriptPath: finalMdPath
    };

    if (dryRun) {
        console.log(`  DRY Local Whisper [${domainName}]: ${basename(absInput)}`);
        console.log(`  DRY Transcript -> ${finalMdPath}`);
        console.log(`  DRY Segment index -> ${segmentIndexPath}`);
        console.log(`  DRY Archive source -> ${archivePath}`);
        return plannedResult;
    }

    const whisperBin = findWhisperCli();
    if (!whisperBin) {
        throw new Error('whisper-cli is required for speech. The source remains in inbox; install whisper.cpp and put whisper-cli on PATH, or provide a local transcription sensor, then ingest again.');
    }
    ensureModel();

    console.log(`\nIngesting media (${isVideo ? 'Video' : 'Audio'}): ${basename(absInput)}`);
    convertToWav(absInput, tempWav, ext);

    const outputBase = join(os.tmpdir(), `whisper_out_${Date.now()}`);
    console.log(`Transcribing with ${whisperBin}...`);
    execFileSync(whisperBin, ['-m', MODEL_PATH, '-f', tempWav, '-otxt', '-oj', '-of', outputBase], { stdio: 'pipe' });

    // 6. Normalize Whisper's native JSON into one independently addressable
    // segment per JSONL line. The temporary native wrapper is not retained.
    const rawJsonPath = `${outputBase}.json`;
    let segmentCount = 0;
    if (existsSync(rawJsonPath)) {
        const telemetry = JSON.parse(readFileSync(rawJsonPath, 'utf-8'));
        const segments = normalizeWhisperSegments(telemetry, {
            sourceSha256,
            sourceFile: basename(absInput)
        });
        writeJsonl(segmentIndexPath, segments);
        unlinkSync(rawJsonPath);
        segmentCount = segments.length;
        console.log(`Generated Segment Index (Tier 2): ${segmentIndexPath}`);
    }

    // 7. Reconstruct prose for the human-readable Tier 2 Markdown record.
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

    const cleanTitle = mediaTitle(baseName);
    const dateStr = localDateString();

    const archiveLink = relative(dirname(finalMdPath), archivePath).split('\\').join('/');
    const segmentIndexLink = relative(dirname(finalMdPath), segmentIndexPath).split('\\').join('/');
    const mdContent = `---
id: "${domainPrefix}:transcript-${slug}"
parent: "${parentNode}"
related: []
title: "Transcript: ${cleanTitle}"
description: "Local machine transcript of ${basename(absInput)} generated by Whisper."
type: "transcript"
domain: "${domainName}"
exposure: "${domain.exposure}"
status: "active"
created: ${dateStr}
updated: ${dateStr}
source_sha256: "${sourceSha256}"
tags: ["${domainName}", "transcript", "machine-transcript", "assets", "${isVideo ? 'video' : 'audio'}"]
---

# Transcript: ${cleanTitle}

**Source Media:** [${basename(archivePath)}](${archiveLink})
**Timestamped Whisper Index (Tier 2):** [transcript-${slug}.segments.jsonl](${segmentIndexLink})
**Media Type:** ${isVideo ? 'Video' : 'Audio'} (${ext})
**Transcription Engine:** Local ${basename(whisperBin)}
**Model:** ${DEFAULT_MODEL}
**Indexed Segments:** ${segmentCount || 'Not available'}
**Date Processed:** ${dateStr}

> Machine-generated transcript. It may contain recognition errors; use the timestamped Whisper index for exact review.

---

## Machine Transcript

${cleanBody}
`;

    writeFileSync(finalMdPath, mdContent, 'utf-8');

    if (existsSync(tempWav)) unlinkSync(tempWav);

    // Archive-Move Invariant: Move raw source media to inbox/archive if not already there
    const absInputPosixFinal = absInput.split(sep).join('/');
    if (absInputPosixFinal.includes('/inbox/') && !absInputPosixFinal.includes('/inbox/archive/')) {
        renameSync(absInput, archivePath);
        console.log(`Archived source media: ${archivePath}`);
    }

    console.log(`\n${ui.success('Media ingestion complete')}`);
    console.log(`Generated Transcript (Tier 2): ${finalMdPath}`);
    return { ...plannedResult, recordCount: segmentCount };
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
