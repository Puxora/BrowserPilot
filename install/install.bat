@echo off
setlocal enabledelayedexpansion
title BrowserPilot - 安装

set "PROJECT_DIR=%~dp0.."
set "HOST_NAME=com.browserpilot.bridge"
set "MANIFEST_DIR=%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts"
set "REGPATH=HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"

echo ============================================
echo   BrowserPilot - 安装程序
echo ============================================
echo.

:: 1. 检查 Node.js
echo [1/6] 检查 Node.js...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [错误] 未找到 Node.js，请先安装 Node.js >= 18
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo   已找到 Node.js %NODE_VER%
echo.

:: 2. 安装 npm 依赖
echo [2/6] 安装 orchestrator 依赖...
cd /d "%PROJECT_DIR%\orchestrator"
call npm install --silent
if %ERRORLEVEL% neq 0 (
    echo [警告] npm install 可能存在问题，尝试继续...
)
echo.

:: 3. 定位 node.exe 绝对路径（用于 manifest 的 path 直连）
echo [3/6] 定位 Node.js 路径...
set "NODE_EXE="
for /f "tokens=*" %%i in ('where node') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
)
if "%NODE_EXE%"=="" (
    echo [错误] 无法定位 node.exe
    pause
    exit /b 1
)
set "RELAY_JS=%PROJECT_DIR%\orchestrator\native-relay.js"
if not exist "%RELAY_JS%" (
    echo [错误] 未找到 native-relay.js: %RELAY_JS%
    pause
    exit /b 1
)
echo   node.exe: %NODE_EXE%
echo   relay  : %RELAY_JS%
echo.

:: 4. 加载 Chrome 扩展
echo [4/6] 请在 Chrome 中加载扩展:
echo    a) 打开 chrome://extensions/
echo    b) 开启右上角"开发者模式"
echo    c) 点击"加载已解压的扩展程序"
echo    d) 选择目录:
echo       %PROJECT_DIR%\chrome-extension\
echo.
echo   加载后，扩展 ID 会显示在扩展卡片上（32位小写字母）
echo.
set /p EXTENSION_ID="请输入扩展 ID: "
if "%EXTENSION_ID%"=="" (
    echo [错误] 扩展 ID 不能为空
    pause
    exit /b 1
)
echo.

:: 5. 注册 Native Messaging Host（用 node 生成 manifest 与 host 包装器）
echo [5/6] 注册 Native Messaging Host...
if not exist "%MANIFEST_DIR%" mkdir "%MANIFEST_DIR%"

node "%PROJECT_DIR%\install\generate-manifest.js" "%EXTENSION_ID%" "%NODE_EXE%" "%RELAY_JS%" "%MANIFEST_DIR%"
if %ERRORLEVEL% neq 0 (
    echo [错误] manifest 生成失败
    pause
    exit /b 1
)
set "MANIFEST_FILE=%MANIFEST_DIR%\%HOST_NAME%.json"
if not exist "%MANIFEST_FILE%" (
    echo [错误] manifest 文件生成失败
    pause
    exit /b 1
)
echo   manifest: %MANIFEST_FILE%

:: 注册表
reg add "%REGPATH%" /ve /t REG_SZ /d "%MANIFEST_DIR%\%HOST_NAME%.json" /f >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [错误] 注册表写入失败，请以管理员身份运行
    pause
    exit /b 1
)
echo   注册表: OK
echo.

:: 6. 启动 daemon
echo [6/6] 启动调度器...
start "BrowserPilot Daemon" cmd /c "cd /d %PROJECT_DIR%\orchestrator && node src\index.js"
echo.

echo ============================================
echo   安装完成!
echo ============================================
echo.
echo   管理面板:  http://127.0.0.1:9876
echo   MCP 适配器: %PROJECT_DIR%\orchestrator\mcp-adapter.js
echo.
echo   Claude Code 配置 (添加到 settings.json):
echo   "mcpServers": {
echo     "browser-pilot": {
echo       "command": "node",
echo       "args": ["%PROJECT_DIR:\=\\%\\orchestrator\\mcp-adapter.js"]
echo     }
echo   }
echo.
echo   使用说明:
echo   1. 确保 Chrome 正在运行且扩展已加载
echo   2. 在新标签页打开扩展，或刷新任意页面
echo   3. 检查管理面板中 Chrome 连接状态
echo.
pause
