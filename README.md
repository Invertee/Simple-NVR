# Lightweight CCTV Recorder

A basic Windows-friendly Node.js/Express application that continuously records RTSP cameras using FFmpeg stream copy. It does **no video re-encoding**, splits recordings into 10-minute chunks, restarts failed FFmpeg processes, and deletes the oldest completed chunks when a camera reaches its configured quota.

It can also poll supported standalone Reolink cameras for motion and on-camera AI detections. Person, vehicle, animal, visitor, and other supported detections are saved as metadata and shown beside the corresponding recording chunk. No computer-side video analysis is performed.

## Requirements

- Windows 10/11
- Node.js 18 or newer
- FFmpeg available as `ffmpeg` on `PATH` (or set `FFMPEG_PATH`)
- Reolink cameras configured with RTSP enabled

Use the Reolink H.264 main stream for the best browser playback support. A typical URL is:

```text
rtsp://username:password@192.168.1.50:554/h264Preview_01_main
```

## Install and run

```powershell
npm install
$env:CCTV_RECORDING_ROOT = 'D:\CCTV'
npm start
```

Open <http://localhost:3000>, choose **Add camera**, and enter its RTSP URL and storage limit. The default recording directory is `recordings` inside this project if `CCTV_RECORDING_ROOT` is not set.

For event markers, edit each existing camera and enable **Store Reolink motion/person/animal markers**. The API host and login are derived from the RTSP URL. Use HTTP port 80 or HTTPS port 443 according to the camera's **Network > Advanced > Server Settings** configuration. Event polling runs every two seconds.

Configuration and logs live in `data`. Camera passwords are stored in plain text in `data/config.json`, so restrict filesystem access to the Windows account running the service. Passwords are redacted in the UI and logs.

Optional environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `CCTV_RECORDING_ROOT` | Scratch disk/directory | `./recordings` |
| `CCTV_DATA_DIR` | Persistent config and logs | `./data` |
| `FFMPEG_PATH` | Full path to `ffmpeg.exe` | `ffmpeg` |
| `PORT` | Web server port | `3000` |

## Start automatically on Windows

Open **PowerShell as Administrator**, change to this project directory, and run:

```powershell
.\scripts\install-service.ps1 -RecordingRoot 'D:\CCTV'
```

If FFmpeg is not on `PATH`, provide its full location:

```powershell
.\scripts\install-service.ps1 -RecordingRoot 'D:\CCTV' -FfmpegPath 'C:\ffmpeg\bin\ffmpeg.exe'
```

This creates and immediately starts a background Scheduled Task named **CCTV Recorder** under the Windows `SYSTEM` account. It starts at machine boot and Task Scheduler restarts it one minute after an unexpected exit. The application's own watchdog independently restarts individual FFmpeg camera processes after five seconds.

Re-running the command safely replaces the existing task. To stop and uninstall it while retaining configuration and recordings:

```powershell
.\scripts\install-service.ps1 -Uninstall
```

Useful management commands:

```powershell
Get-ScheduledTask -TaskName 'CCTV Recorder'
Start-ScheduledTask -TaskName 'CCTV Recorder'
Stop-ScheduledTask -TaskName 'CCTV Recorder'
```

Quota cleanup runs once per minute and never selects the newest chunk, which may still be open for writing.

## Container choice

- **MP4** is the default and offers the best in-browser playback for H.264 streams.
- **MKV** tolerates abrupt power/process failures better, but browser playback support is limited. Recordings can always be downloaded and played in VLC.

Removing a camera from the UI stops its recorder but intentionally leaves its existing recording directory on disk.
