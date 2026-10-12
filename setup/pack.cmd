@echo off
chcp 65001 >nul
rem 收状态：把 ~/.dsh 下那几样收进 deploy/，然后 git 提交。
rem
rem 为什么套一层 cmd：Windows 默认禁止直接运行 .ps1，双击会被拒。
rem 这里显式带 -ExecutionPolicy Bypass，只影响这一个进程，不改系统设置。
rem
rem ⚠️ 本文件必须是 CRLF 行尾。cmd.exe 用 LF 读批处理会把 rem 行和下一行
rem    连起来解析，中文注释会被当成命令去执行。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pack.ps1" %*
echo.
pause
