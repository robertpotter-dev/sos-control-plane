param (
    [Parameter(Mandatory = $true)]
    [string]$Target,
    [Parameter(Mandatory = $true)]
    [string]$Domain,
    [Parameter(Mandatory = $true)]
    [string]$Output,
    [Parameter(Mandatory = $true)]
    [string]$OutputJson,
    [Parameter(Mandatory = $true)]
    [string]$Id
)

$lib = Join-Path $PSScriptRoot '..\..\lib\portable-vision.mjs'
& node $lib $Target $Domain $Output $OutputJson $Id
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
