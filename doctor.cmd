@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0doctor.ps1" %*
set "DOCREVIEW_CHECK_EXIT=%errorlevel%"
if not defined DOCREVIEW_NO_PAUSE pause
exit /b %DOCREVIEW_CHECK_EXIT%
