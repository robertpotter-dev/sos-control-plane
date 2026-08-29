import { commandExists } from './tools.mjs';

const SKIP = new Set(['Repository root', 'Domain charters', 'Vault Target']);

const BREW = {
    node: 'node',
    git: 'git',
    ffmpeg: 'ffmpeg',
    'yt-dlp': 'yt-dlp',
    tesseract: 'tesseract',
    pdftotext: 'poppler',
    'HEIC/DNG decoder': 'ffmpeg',
    'whisper-cli': 'whisper-cpp',
    pandoc: 'pandoc',
    rsync: 'rsync',
    curl: 'curl'
};

const APT = {
    node: 'nodejs',
    git: 'git',
    ffmpeg: 'ffmpeg',
    'yt-dlp': 'yt-dlp',
    tesseract: 'tesseract-ocr',
    pdftotext: 'poppler-utils',
    'HEIC/DNG decoder': 'ffmpeg',
    pandoc: 'pandoc',
    unrtf: 'unrtf',
    rsync: 'rsync',
    curl: 'curl'
};

const DNF = {
    node: 'nodejs',
    git: 'git',
    ffmpeg: 'ffmpeg',
    'yt-dlp': 'yt-dlp',
    tesseract: 'tesseract',
    pdftotext: 'poppler-utils',
    'HEIC/DNG decoder': 'ffmpeg',
    pandoc: 'pandoc',
    unrtf: 'unrtf',
    rsync: 'rsync',
    curl: 'curl'
};

const PACMAN = {
    node: 'nodejs',
    git: 'git',
    ffmpeg: 'ffmpeg',
    'yt-dlp': 'yt-dlp',
    tesseract: 'tesseract',
    pdftotext: 'poppler',
    'HEIC/DNG decoder': 'ffmpeg',
    pandoc: 'pandoc',
    unrtf: 'unrtf',
    rsync: 'rsync',
    curl: 'curl'
};

const WINGET = {
    node: 'OpenJS.NodeJS.LTS',
    git: 'Git.Git',
    ffmpeg: 'Gyan.FFmpeg',
    'yt-dlp': 'yt-dlp.yt-dlp',
    tesseract: 'UB-Mannheim.TesseractOCR',
    pdftotext: 'oschwartz10612.Poppler',
    'HEIC/DNG decoder': 'Gyan.FFmpeg',
    pandoc: 'JohnMacFarlane.Pandoc'
};

const SCOOP = {
    node: 'nodejs-lts',
    git: 'git',
    ffmpeg: 'ffmpeg',
    'yt-dlp': 'yt-dlp',
    tesseract: 'tesseract',
    pdftotext: 'poppler',
    'HEIC/DNG decoder': 'ffmpeg',
    'whisper-cli': 'whisper-cpp',
    pandoc: 'pandoc'
};

const CHOCO = {
    node: 'nodejs-lts',
    git: 'git',
    ffmpeg: 'ffmpeg',
    'yt-dlp': 'yt-dlp',
    tesseract: 'tesseract',
    pdftotext: 'poppler',
    'HEIC/DNG decoder': 'ffmpeg',
    pandoc: 'pandoc'
};

const APPLE_CLT = new Set(['textutil', 'sips', 'swift', 'afconvert']);

export function detectPackageManager({ platform = process.platform, hasCommand = commandExists } = {}) {
    if (platform === 'darwin') {
        if (hasCommand('brew')) return { id: 'brew', platform, label: 'Homebrew' };
        return {
            id: null,
            platform,
            label: null,
            hint: 'Install Homebrew from https://brew.sh for optional tools. Apple CLT: xcode-select --install.'
        };
    }
    if (platform === 'win32') {
        if (hasCommand('winget')) return { id: 'winget', platform, label: 'winget' };
        if (hasCommand('scoop')) return { id: 'scoop', platform, label: 'scoop' };
        if (hasCommand('choco')) return { id: 'choco', platform, label: 'Chocolatey' };
        return {
            id: null,
            platform,
            label: null,
            hint: 'Install winget (App Installer) from Microsoft, then re-run sos doctor.'
        };
    }
    if (hasCommand('apt-get')) return { id: 'apt', platform, label: 'apt' };
    if (hasCommand('dnf')) return { id: 'dnf', platform, label: 'dnf' };
    if (hasCommand('pacman')) return { id: 'pacman', platform, label: 'pacman' };
    return {
        id: null,
        platform,
        label: null,
        hint: 'Install the missing tool with your distribution package manager and put it on PATH.'
    };
}

function render(kind, pkg) {
    if (kind === 'brew') return `brew install ${pkg}`;
    if (kind === 'apt') return `sudo apt install ${pkg}`;
    if (kind === 'dnf') return `sudo dnf install ${pkg}`;
    if (kind === 'pacman') return `sudo pacman -S ${pkg}`;
    if (kind === 'scoop') return `scoop install ${pkg}`;
    if (kind === 'choco') return `choco install ${pkg}`;
    if (kind === 'winget') return `winget install --id ${pkg} -e`;
    if (kind === 'xcode') return 'xcode-select --install';
    return null;
}

function packageTable(managerId) {
    if (managerId === 'brew') return BREW;
    if (managerId === 'apt') return APT;
    if (managerId === 'dnf') return DNF;
    if (managerId === 'pacman') return PACMAN;
    if (managerId === 'winget') return WINGET;
    if (managerId === 'scoop') return SCOOP;
    if (managerId === 'choco') return CHOCO;
    return {};
}

export function installHint(checkName, manager, { missingNames = [] } = {}) {
    const platform = manager?.platform ?? process.platform;
    if (SKIP.has(checkName)) return null;
    if (checkName === 'Swift SDK compatibility') {
        return { note: 'Install a matching Xcode and Command Line Tools pair, then re-run sos doctor.' };
    }
    if (checkName === 'powershell') {
        return { note: 'Use Windows PowerShell 5+ or PowerShell 7.' };
    }
    if (APPLE_CLT.has(checkName)) {
        return { kind: 'xcode', command: 'xcode-select --install' };
    }
    if (checkName === 'unrtf' && !missingNames.includes('pandoc')) {
        return { note: 'Optional. pandoc already covers RTF.' };
    }
    if (checkName === 'rsync' && platform === 'win32') {
        return { note: 'Optional. sos sync mirrors without rsync.' };
    }
    if (checkName === 'whisper-cli' && !['brew', 'scoop'].includes(manager?.id)) {
        return {
            note: manager?.id === 'winget'
                ? 'Download whisper.cpp and put whisper-cli on PATH, or install scoop and run: scoop install whisper-cpp'
                : 'Build whisper.cpp and put whisper-cli on PATH: https://github.com/ggml-org/whisper.cpp'
        };
    }
    const pkg = packageTable(manager?.id)[checkName];
    if (pkg && manager?.id) {
        return { kind: manager.id, package: pkg, command: render(manager.id, pkg) };
    }
    if (manager?.hint) return { note: manager.hint };
    return { note: `Install ${checkName} with your OS package manager and put it on PATH.` };
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

export function combineInstallCommands(hints) {
    const groups = new Map();
    const other = [];
    for (const hint of hints) {
        if (!hint?.command) continue;
        if (hint.kind === 'xcode') {
            other.push(hint.command);
            continue;
        }
        if (hint.kind === 'winget') {
            other.push(hint.command);
            continue;
        }
        if (hint.kind && hint.package) {
            const list = groups.get(hint.kind) ?? [];
            list.push(hint.package);
            groups.set(hint.kind, list);
            continue;
        }
        other.push(hint.command);
    }
    const combined = [];
    for (const kind of ['brew', 'apt', 'dnf', 'pacman', 'scoop', 'choco']) {
        const packages = unique(groups.get(kind) ?? []);
        if (packages.length) combined.push(render(kind, packages.join(' ')));
    }
    return unique([...combined, ...other]);
}

export function attachInstallHints(checks, { manager } = {}) {
    const resolved = manager ?? detectPackageManager();
    const missingNames = checks.filter(check => !check.ok).map(check => check.name);
    const annotated = checks.map(check => {
        if (check.ok) return { ...check, install: null };
        const hint = installHint(check.name, resolved, { missingNames });
        return { ...check, install: hint?.command ?? hint?.note ?? null, installHint: hint };
    });
    const install = combineInstallCommands(annotated.map(check => check.installHint));
    return {
        checks: annotated.map(({ installHint, ...check }) => check),
        install,
        packageManager: {
            id: resolved.id,
            platform: resolved.platform,
            ...(resolved.hint ? { hint: resolved.hint } : {})
        }
    };
}
