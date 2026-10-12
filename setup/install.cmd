@echo off
chcp 65001 >nul
rem 在新机器上装回去：链接两个包 + 还原记忆/修正/技能/设置。
rem
rem 可选参数，例如装到别的位置：
rem     install.cmd -Repo <本仓库>
rem     install.cmd -DshHome "%USERPROFILE%\.dsh"
rem
rem ⚠️ 本文件必须是 CRLF 行尾。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
