#Requires -RunAsAdministrator
param(
    [string]$RecordingRoot = 'D:\CCTV',
    [string]$FfmpegPath = 'ffmpeg',
    [int]$Port = 3000,
    [string]$TaskName = 'CCTV Recorder',
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed '$TaskName'. Recordings and configuration were retained."
    } else {
        Write-Host "'$TaskName' is not installed."
    }
    exit 0
}

$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runnerPath = Join-Path $PSScriptRoot 'service-runner.ps1'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw 'node.exe was not found. Install Node.js and ensure it is on PATH before running this script.'
}
$nodePath = $nodeCommand.Source

if ($FfmpegPath -eq 'ffmpeg') {
    $ffmpegCommand = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if (-not $ffmpegCommand) {
        throw 'ffmpeg.exe was not found. Install FFmpeg or pass -FfmpegPath C:\path\to\ffmpeg.exe.'
    }
    $FfmpegPath = $ffmpegCommand.Source
} elseif (-not (Test-Path -LiteralPath $FfmpegPath -PathType Leaf)) {
    throw "FFmpeg was not found at '$FfmpegPath'."
} else {
    $FfmpegPath = (Resolve-Path -LiteralPath $FfmpegPath).Path
}

New-Item -ItemType Directory -Path $RecordingRoot -Force | Out-Null
$RecordingRoot = (Resolve-Path -LiteralPath $RecordingRoot).Path

$arguments = @(
    '-NoProfile'
    '-NonInteractive'
    '-ExecutionPolicy', 'Bypass'
    '-File', ('"{0}"' -f $runnerPath)
    '-ProjectDirectory', ('"{0}"' -f $projectDirectory)
    '-NodePath', ('"{0}"' -f $nodePath)
    '-RecordingRoot', ('"{0}"' -f $RecordingRoot)
    '-FfmpegPath', ('"{0}"' -f $FfmpegPath)
    '-Port', $Port
) -join ' '

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $projectDirectory
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Continuous RTSP CCTV recorder and FFmpeg watchdog' | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "Installed and started '$TaskName'."
Write-Host "State: $($task.State)"
Write-Host "Last result: $($info.LastTaskResult)"
Write-Host "Dashboard: http://localhost:$Port"
Write-Host "Recordings: $RecordingRoot"
Write-Host "The task starts at boot and is restarted one minute after an unexpected exit."
