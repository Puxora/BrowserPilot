@echo off
title BrowserPilot - 卸载

echo === BrowserPilot - 卸载 ===
echo.

set "HOST_NAME=com.browserpilot.bridge"
set "MANIFEST_DIR=%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts"

:: 删除注册表
echo [1/3] 删除注册表项...
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chrome-automation.bridge" /f >nul 2>&1
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chrome_automation.bridge" /f >nul 2>&1
echo   已删除

:: 删除 manifest 文件
echo [2/3] 删除 manifest 文件...
if exist "%MANIFEST_DIR%\%HOST_NAME%.json" (
    del "%MANIFEST_DIR%\%HOST_NAME%.json"
    echo   已删除: %MANIFEST_DIR%\%HOST_NAME%.json
) else (
    echo   文件不存在，跳过
)
if exist "%MANIFEST_DIR%\com.chrome-automation.bridge.json" (
    del "%MANIFEST_DIR%\com.chrome-automation.bridge.json"
    echo   已删除: %MANIFEST_DIR%\com.chrome-automation.bridge.json
)
if exist "%MANIFEST_DIR%\com.chrome_automation.bridge.json" (
    del "%MANIFEST_DIR%\com.chrome_automation.bridge.json"
    echo   已删除: %MANIFEST_DIR%\com.chrome_automation.bridge.json
)

:: 提示删除扩展
echo [3/3] 请在 Chrome 中卸载扩展:
echo   a) 打开 chrome://extensions/
echo   b) 找到 "BrowserPilot"
echo   c) 点击"移除"
echo.
echo === 卸载完成 ===
echo.
echo 项目的代码文件和任务数据未删除，位于:
echo   %~dp0..
echo.
echo 如需彻底删除，请手动删除上述目录。
echo.

pause
