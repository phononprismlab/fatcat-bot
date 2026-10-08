@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 没找到 node。请先安装 Node.js 22.5 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node"') do set NODEVER=%%v
for /f "tokens=1,2 delims=." %%a in ("%NODEVER%") do (
  set MAJOR=%%a
  set MINOR=%%b
)

if %MAJOR% LSS 22 (
  echo [x] Node 版本过低：当前 %NODEVER%，需要 22.5 或更高（要用内置的 node:sqlite）
  pause
  exit /b 1
)
if %MAJOR% EQU 22 if %MINOR% LSS 5 (
  echo [x] Node 版本过低：当前 %NODEVER%，需要 22.5 或更高（要用内置的 node:sqlite）
  pause
  exit /b 1
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo [i] 已从 .env.example 生成 .env —— 请按需修改（至少看一眼 ONEBOT_WS_URL 和 ADMIN_TOKEN）
)

echo [*] 启动【肥肥风筝猫】（Node %NODEVER%）
node --experimental-sqlite src/index.js
pause
