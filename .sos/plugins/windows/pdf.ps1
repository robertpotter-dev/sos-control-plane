param (
    [Parameter(Mandatory = $true)]
    [string]$SourcePath
)

$pdfToText = Get-Command pdftotext -ErrorAction SilentlyContinue
if (-not $pdfToText) {
    Write-Error "pdftotext is required for PDF extraction. Install poppler, or use sos ingest --frontier."
    exit 1
}

& pdftotext -layout -enc UTF-8 $SourcePath -
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
