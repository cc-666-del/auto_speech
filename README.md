# Auto Speech

[![GitHub stars](https://img.shields.io/github/stars/cc-666-del/auto_speech?style=social)](https://github.com/cc-666-del/auto_speech/stargazers)
[![Release](https://img.shields.io/github/v/release/cc-666-del/auto_speech)](https://github.com/cc-666-del/auto_speech/releases)
[![Downloads](https://img.shields.io/github/downloads/cc-666-del/auto_speech/total)](https://github.com/cc-666-del/auto_speech/releases)

Auto Speech is a desktop voiceover tool for generating narration audio with a cloned local voice.

## Download

Download the Windows installer from the [v0.1.0 release](https://github.com/cc-666-del/auto_speech/releases/tag/v0.1.0).

Download and run `AutoSpeech-Setup-0.1.0.exe`. The installer opens a normal setup wizard, lets you choose the installation directory, and creates desktop and Start menu shortcuts.

The installer includes the desktop app, model service, and setup scripts. It does not include CosyVoice model weights or the Python virtual environment. After installing:

1. Launch Auto Speech.
2. Open the model settings page.
3. Click `Initialize CosyVoice`.
4. Wait for the PowerShell setup window to finish downloading and installing the model environment.
5. Return to Auto Speech and click `Load`.

You can also run the setup script manually from the installed app folder:

```powershell
.\resources\app\scripts\setup-cosyvoice.ps1
```

## System Requirements

Minimum recommended computer:

- Windows 10 or Windows 11, 64-bit.
- NVIDIA GPU with CUDA support and at least 8 GB VRAM.
- 16 GB system RAM.
- 25 GB free disk space for the app, CosyVoice repository, Python environment, PyTorch, and model weights.
- Python 3.10 or 3.11 available on the system path or through the Windows Python launcher.
- Stable internet connection for first-time CosyVoice initialization.

Recommended for smoother local generation:

- NVIDIA GPU with 12 GB or more VRAM.
- 32 GB system RAM.
- Recent NVIDIA driver.

CPU-only usage is not the target path for this app and may be too slow for practical narration generation.

## Current Stack

- Desktop: Electron.
- UI: React + TypeScript.
- Model service: Python HTTP service.
- GPU detection: `nvidia-smi`.

## Development Setup

Install Node dependencies:

```powershell
npm.cmd install
```

If PowerShell blocks `npm`, use `npm.cmd` as shown above. The project also includes `.npmrc` so npm writes cache files to `.npm-cache` inside the project.

In this sandbox, Electron's binary download may be blocked. If that happens, install the JS dependencies first:

```powershell
$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'
npm.cmd install --offline
```

Then run the web preview while the Electron binary is not available:

```powershell
npm.cmd run dev:web
```

To complete the desktop runtime later, run this from a normal terminal with network access:

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
node node_modules/electron/install.js
```

Run the desktop app:

```powershell
npm.cmd run dev
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=cc-666-del/auto_speech&type=Date)](https://www.star-history.com/#cc-666-del/auto_speech&Date)
