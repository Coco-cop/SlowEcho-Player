@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" goto install
py -3.12 -m venv .venv 2>nul
if not errorlevel 1 goto install
py -3.11 -m venv .venv 2>nul
if not errorlevel 1 goto install
python -m venv .venv
if errorlevel 1 goto failed
:install
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto failed
echo.
echo Setup complete. Run start.cmd to open SlowEcho Player.
exit /b 0
:failed
echo.
echo Setup failed. Install Python 3.11 or 3.12 and check your network.
if /i not "%~1"=="--no-pause" pause
exit /b 1
