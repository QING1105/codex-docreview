@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "DOCREVIEW_INSTALL_EXIT=%errorlevel%"
if not defined DOCREVIEW_NO_PAUSE pause
exit /b %DOCREVIEW_INSTALL_EXIT%
