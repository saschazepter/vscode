@echo off
setlocal

for /f "tokens=*" %%a in ('powershell -NoProfile -Command "[int](Get-CimInstance Win32_Processor).Architecture"') do set ARCH=%%a
if "%ARCH%"=="12" (set "ARCH_NAME=ARM64") else if "%ARCH%"=="9" (set "ARCH_NAME=AMD64") else if "%ARCH%"=="5" (set "ARCH_NAME=ARM") else (set "ARCH_NAME=x86")

echo System: %OS% %ARCH_NAME%
powershell -NoProfile -Command "$mem = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; Write-Host ('Memory: {0:N0} GB' -f ($mem/1GB))"
powershell -NoProfile -Command "$disk = Get-PSDrive C; Write-Host ('Disk C: {0:N0} GB free of {1:N0} GB' -f ($disk.Free/1GB), (($disk.Used+$disk.Free)/1GB))"

set "UBUNTU_INSTALL=%LOCALAPPDATA%\WSL\Ubuntu"

where wsl >nul 2>nul
if errorlevel 1 (
    echo WSL is not installed, enabling Windows feature
    powershell -Command "Start-Process -Wait -Verb RunAs dism.exe -ArgumentList '/online','/enable-feature','/featurename:Microsoft-Windows-Subsystem-Linux','/all','/norestart'"
    powershell -Command "Start-Process -Wait -Verb RunAs dism.exe -ArgumentList '/online','/enable-feature','/featurename:VirtualMachinePlatform','/all','/norestart'"
)

REM Ensure wsl.exe is in PATH (it may have just been installed)
set "PATH=%SystemRoot%\System32;%PATH%"

echo Checking if Ubuntu WSL is available
"%SystemRoot%\System32\wsl.exe" -d Ubuntu echo "WSL is ready" 2>nul
if errorlevel 1 call :install_wsl

set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe

echo Running sanity tests
node "%~dp0..\out\index.js" %*
goto :eof

:install_wsl
echo Ubuntu not found, installing via rootfs import

if "%ARCH%"=="12" (
    set "UBUNTU_ROOTFS=%TEMP%\ubuntu-rootfs-arm64.tar.gz"
    set "UBUNTU_URL=https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-arm64-ubuntu22.04lts.rootfs.tar.gz"
) else (
    set "UBUNTU_ROOTFS=%TEMP%\ubuntu-rootfs-amd64.tar.gz"
    set "UBUNTU_URL=https://cloud-images.ubuntu.com/wsl/jammy/current/ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz"
)

if not exist "%UBUNTU_ROOTFS%" (
    echo Downloading Ubuntu rootfs from %UBUNTU_URL%
    curl -L -o "%UBUNTU_ROOTFS%" "%UBUNTU_URL%"
)

echo Importing Ubuntu into WSL
mkdir "%UBUNTU_INSTALL%" 2>nul
"%SystemRoot%\System32\wsl.exe" --import Ubuntu "%UBUNTU_INSTALL%" "%UBUNTU_ROOTFS%"

echo Starting WSL
"%SystemRoot%\System32\wsl.exe" -d Ubuntu echo WSL is ready
goto :eof
