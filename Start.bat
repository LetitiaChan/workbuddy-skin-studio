@echo off
REM WorkBuddy Skin Studio - apply (Windows batch wrapper)
REM Thin wrapper around scripts\apply.ps1 so behavior stays identical:
REM restart WorkBuddy with CDP port 9223 (skip if already debuggable),
REM then inject the skin.
REM
REM Usage:
REM   apply.bat              apply default theme (miku-light)
REM   apply.bat genshin-night
REM   apply.bat mice-cat
setlocal
set "ROOT=%~dp0"
set "THEME=%~1"

if defined THEME (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\apply.ps1" -Theme "%THEME%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\apply.ps1"
)

if errorlevel 1 (
  echo.
  echo [skin-studio] apply failed. See messages above.
  pause
)
endlocal
