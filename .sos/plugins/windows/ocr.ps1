param (
    [Parameter(Mandatory = $true)]
    [string]$ImagePath
)

if (-not (Test-Path -LiteralPath $ImagePath)) {
    Write-Error "Image does not exist: $ImagePath"
    exit 1
}

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1
} | Select-Object -First 1

function Await-WinRT($operation) {
    $asTask = $asTaskGeneric.MakeGenericMethod($operation.GetType().GenericTypeArguments[0])
    $task = $asTask.Invoke($null, @($operation))
    $task.Wait() | Out-Null
    return $task.Result
}

$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) {
    Write-Error 'Windows OCR is not available on this machine.'
    exit 1
}

$file = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $ImagePath).Path))
$stream = Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read))
$decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))
$bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync())
$result = Await-WinRT ($engine.RecognizeAsync($bitmap))

foreach ($line in $result.Lines) {
    if ($line.Text) { Write-Output $line.Text }
}
