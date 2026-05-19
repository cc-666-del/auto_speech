@echo off
setlocal
cd /d "%~dp0\.."

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

for /f %%v in ('node -p "require('./package.json').version"') do set APP_VERSION=%%v

call npm.cmd run installer
if errorlevel 1 exit /b %errorlevel%

echo.
echo Installer build complete.
echo Output folder: %cd%\release
echo Expected installer name: AutoSpeech-Setup-%APP_VERSION%.exe
endlocal
