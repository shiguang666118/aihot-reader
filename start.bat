@echo off
cd /d "%~dp0"
echo Starting AI HOT reader...
start "" "http://127.0.0.1:8765"
node server.mjs
pause
