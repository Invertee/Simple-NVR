param(
    [Parameter(Mandatory = $true)][string]$ProjectDirectory,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$RecordingRoot,
    [string]$FfmpegPath = 'ffmpeg',
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$env:CCTV_RECORDING_ROOT = $RecordingRoot
$env:FFMPEG_PATH = $FfmpegPath
$env:PORT = [string]$Port

Set-Location -LiteralPath $ProjectDirectory
& $NodePath (Join-Path $ProjectDirectory 'src\server.js')
exit $LASTEXITCODE
