@echo off
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.10+ is required. Install from https://www.python.org/downloads/windows/
  pause
  exit /b 1
)
python server.py --origin https://marronyao.github.io --open-browser
pause
