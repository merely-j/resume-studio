@echo off
setlocal
rem ============================================================
rem  简历工坊 一键启动
rem  双击本文件：自动启动本地服务器并打开浏览器
rem  若浏览器未自动打开，请手动访问 http://localhost:8080/
rem ============================================================

pushd "%~dp0"
if errorlevel 1 (
  echo [错误] 无法进入脚本所在目录
  pause
  exit /b 1
)

set "NODE=node"
node -v >nul 2>nul
if errorlevel 1 set "NODE=C:\Users\86188\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 没有找到 Node.js，请先安装：https://nodejs.org/
  echo 安装完成后重新双击本文件。
  echo.
  pause
  exit /b 1
)

if /i "%~1"=="--no-open" goto serve

rem 延迟 2 秒打开浏览器，等服务器就绪
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8080/'"

:serve
echo.
echo   正在启动简历工坊……关闭本窗口即停止服务
echo.
"%NODE%" server.mjs

echo.
echo [服务已停止] 若提示 EADDRINUSE，说明已有另一个窗口在运行。
pause
