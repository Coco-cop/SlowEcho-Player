@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" goto missing
".venv\Scripts\python.exe" -c "import faster_whisper, av, numpy, qrcode" >nul 2>&1
if errorlevel 1 goto missing
echo SlowEcho Player - press Ctrl+C in this window to stop.
".venv\Scripts\python.exe" serve_phone.py %*
exit /b %errorlevel%
:missing
echo Run setup.cmd first to install Python dependencies.
pause
exit /b 1
