# Auto Speech

Auto Speech is a desktop voiceover tool for generating narration audio with a cloned local voice.

The project is currently in the engineering skeleton stage. The first milestone is to make the desktop app reliably start, monitor, load, unload, and shut down a local model service.

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

## Build a Windows Installer

The build creates a downloadable Windows `.exe` installer, for example `AutoSpeech-Setup-0.1.0.exe`.
The installer uses a normal setup wizard, lets the user choose the installation directory, and creates desktop and Start menu shortcuts.
The installer packages the desktop app, model service, and setup scripts. It does not bundle the local CosyVoice repository, model weights, or Python virtual environment because that payload is too large for a reliable single-file NSIS installer.

Build with the mirror-aware helper:

```cmd
scripts\build-installer.cmd
```

Or run npm directly:

```powershell
npm.cmd run installer
```

The installer will be created in `release/`.
After installing, launch Auto Speech from the desktop shortcut or Start menu.
To enable real CosyVoice generation on a newly installed copy, run the bundled `scripts\setup-cosyvoice.ps1` from the installed app folder.

For a faster unpacked app folder without an installer:

```powershell
npm.cmd run pack:win
```

Run the model service manually:

```powershell
.\.venv\Scripts\python.exe model_service/main.py --port 8765
```

Current local note: Python 3.11 is installed and should be used for the model service.

## Important Files

- `TODO.md`: project progress tracker.
- `docs/product-plan.md`: product and architecture plan.
- `src/main/modelManager.ts`: desktop-side model process manager.
- `model_service/main.py`: local model service skeleton.
- `model_service/model_config.json`: model adapter configuration.

## GPU Strategy

The app is designed to load the model when the software starts and unload it when the software closes. Manual controls are also planned and partially scaffolded in the UI.

## CosyVoice Model

Install CosyVoice and download the CosyVoice2-0.5B model:

```powershell
.\scripts\setup-cosyvoice.ps1
```

Switch the active adapter back to CosyVoice if needed:

```powershell
.\scripts\use-cosyvoice-model.ps1
```
