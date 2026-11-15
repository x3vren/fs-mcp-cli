@echo off
setlocal
where node >nul 2>&1 || (echo Node.js est introuvable. Installez-le depuis https://nodejs.org & pause & exit /b 1)
if not exist "%~dp0node_modules" (echo Installation des dependances... & pushd "%~dp0" & call npm install --silent & popd)
node "%~dp0src\index.js" %*
if errorlevel 1 pause

