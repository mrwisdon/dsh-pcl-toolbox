@echo off
chcp 65001 >nul
echo === pcl-toolbox 回滚：从 desktop profile 卸下插件 ===
node "%~dp0scripts\uninstall.mjs" || goto :err
echo.
echo 正在 pnpm install ...
call pnpm -C "%USERPROFILE%\.dsh\profiles\desktop" install || goto :err
echo.
echo 完成。请重启 DeepSeek Harness。
pause
exit /b 0
:err
echo.
echo 上面有报错。也可以手工编辑：
echo   %USERPROFILE%\.dsh\profiles\desktop\package.json
echo 删掉 dependencies 与 dsh.profile.bundles 里的 @dsh-external/pcl-toolbox 两行。
pause
exit /b 1
