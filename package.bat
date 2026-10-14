@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
set "BUILD_EXIT=1"
where /q node.exe
if errorlevel 1 (
  echo Node.js was not found. Install Node.js and reopen this script.
  goto finish
)
where /q npm.cmd
if errorlevel 1 (
  echo npm was not found. Install Node.js with npm and reopen this script.
  goto finish
)
if not exist "node_modules\electron-builder\cli.js" (
  echo Dependencies are missing. Run npm.cmd ci first.
  goto finish
)
if not defined BESTDICT_RELEASE_DIR (
  for /f "delims=" %%V in ('node -p "require('./package.json').version"') do set "BESTDICT_RELEASE_DIR=%CD%\release\v%%V"
)
if not defined BESTDICT_RELEASE_DIR goto finish
echo Building BestDict into "%BESTDICT_RELEASE_DIR%"...
call npm.cmd run package
set "BUILD_EXIT=%ERRORLEVEL%"
if not "%BUILD_EXIT%"=="0" goto finish
echo.
echo Build succeeded. Output: "%BESTDICT_RELEASE_DIR%"
:finish
if not "%BUILD_EXIT%"=="0" echo Build failed. Check the messages above.
popd
if /i not "%~1"=="--no-pause" pause
exit /b %BUILD_EXIT%
