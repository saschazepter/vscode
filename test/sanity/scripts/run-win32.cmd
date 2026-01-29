@echo off
setlocal

for /f "tokens=*" %%a in ('powershell -NoProfile -Command "[int](Get-CimInstance Win32_Processor).Architecture"') do set ARCH=%%a
if "%ARCH%"=="12" (set "ARCH_NAME=ARM64") else if "%ARCH%"=="9" (set "ARCH_NAME=AMD64") else if "%ARCH%"=="5" (set "ARCH_NAME=ARM") else (set "ARCH_NAME=x86")

echo System: %OS% %ARCH_NAME%
powershell -NoProfile -Command "$mem = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; Write-Host ('Memory: {0:N0} GB' -f ($mem/1GB))"
powershell -NoProfile -Command "$disk = Get-PSDrive C; Write-Host ('Disk C: {0:N0} GB free of {1:N0} GB' -f ($disk.Free/1GB), (($disk.Used+$disk.Free)/1GB))"

where wsl >nul 2>nul
if errorlevel 1 call :install_wsl_feature

set "PATH=%ProgramFiles%\WSL;%SystemRoot%\System32;%PATH%"

echo Checking if Ubuntu is available on WSL
powershell -NoProfile -Command "if ((wsl -l -q) -contains 'Ubuntu') { exit 0 } else { exit 1 }"
if errorlevel 1 call :install_ubuntu_image

:run_tests
set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe

echo Running sanity tests
node "%~dp0..\out\index.js" %*
exit /b %ERRORLEVEL%

:install_ubuntu_image

echo Ubuntu image is not present in WSL

if "%ARCH%"=="12" (
    set "ROOTFS_URL=https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-arm64-ubuntu22.04lts.rootfs.tar.gz"
) else (
    set "ROOTFS_URL=https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz"
)

set "ROOTFS_ZIP=%TEMP%\ubuntu-rootfs.tar.gz"
set "ROOTFS_DIR=%LOCALAPPDATA%\WSL\Ubuntu"

echo Downloading Ubuntu rootfs from %ROOTFS_URL% to %ROOTFS_ZIP%
curl -L -o "%ROOTFS_ZIP%" "%ROOTFS_URL%"

echo Importing Ubuntu into WSL at %ROOTFS_DIR% from %ROOTFS_ZIP%
mkdir "%ROOTFS_DIR%" 2>nul
wsl --import Ubuntu "%ROOTFS_DIR%" "%ROOTFS_ZIP%"

echo Starting Ubuntu on WSL
wsl -d Ubuntu echo WSL is ready

goto :eof

:install_wsl_feature

echo WSL does not appear to be installed

echo Enabling WSL and Virtual Machine Platform features
powershell -Command "Start-Process -Wait -Verb RunAs dism.exe -ArgumentList '/online','/enable-feature','/featurename:Microsoft-Windows-Subsystem-Linux','/all','/norestart'"
powershell -Command "Start-Process -Wait -Verb RunAs dism.exe -ArgumentList '/online','/enable-feature','/featurename:VirtualMachinePlatform','/all','/norestart'"

if "%ARCH%"=="12" (
    set "MSI_URL=https://github.com/microsoft/WSL/releases/download/2.6.3/wsl.2.6.3.0.arm64.msi"
) else (
    set "MSI_URL=https://github.com/microsoft/WSL/releases/download/2.6.3/wsl.2.6.3.0.x64.msi"
)

echo Downloading WSL from %MSI_URL%
curl -L -o "%TEMP%\wsl.msi" "%MSI_URL%"

echo Installing WSL with Windows Installer
msiexec /i "%TEMP%\wsl.msi" /quiet /norestart

goto :eof
