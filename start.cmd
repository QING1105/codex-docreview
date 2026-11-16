@echo off
if not defined DOCREVIEW_PORT set "DOCREVIEW_PORT=4517"
node -e "const p=process.env.DOCREVIEW_PORT;if(!/^\d+$/.test(p)||Number(p)<1||Number(p)>65535){console.error('DOCREVIEW_PORT must be an integer from 1 to 65535.');process.exit(1)}"
if errorlevel 1 exit /b 1
start "" "http://127.0.0.1:%DOCREVIEW_PORT%/"
:run
node "%~dp0server\daemon.js"
if %errorlevel%==75 goto run
pause
