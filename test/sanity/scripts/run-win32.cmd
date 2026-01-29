@echo off
setlocal

for /f "tokens=*" %%a in ('powershell -NoProfile -Command "[int](Get-CimInstance Win32_Processor).Architecture"') do set ARCH=%%a
if "%ARCH%"=="12" (set "ARCH_NAME=ARM64") else if "%ARCH%"=="9" (set "ARCH_NAME=AMD64") else if "%ARCH%"=="5" (set "ARCH_NAME=ARM") else (set "ARCH_NAME=x86")

echo System: %OS% %ARCH_NAME%
powershell -NoProfile -Command "$os = Get-CimInstance Win32_OperatingSystem; $total = $os.TotalVisibleMemorySize/1MB; $free = $os.FreePhysicalMemory/1MB; Write-Host ('Memory: {0:N0} GB free of {1:N0} GB' -f $free, $total)"
powershell -NoProfile -Command "$disk = Get-PSDrive C; Write-Host ('Disk C: {0:N0} GB free of {1:N0} GB' -f ($disk.Free/1GB), (($disk.Used+$disk.Free)/1GB))"

echo Checking if WSL is installed
where wsl >nul 2>nul
if errorlevel 1 (
    echo WSL is not installed, skipping WSL setup
) else (
    echo Checking if Ubuntu is available on WSL
    powershell -NoProfile -Command "if ((wsl -l -q) -contains 'Ubuntu') { exit 0 } else { exit 1 }"
    if errorlevel 1 (
        echo Ubuntu image is not present in WSL

        echo Installing Ubuntu via WSL
        wsl --install -d Ubuntu --no-launch

        echo Starting Ubuntu on WSL
        wsl -d Ubuntu echo Ubuntu WSL is ready
    )
)

set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
if "%ARCH%"=="12" (
	set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=C:\Program Files\Microsoft\Edge\Application\msedge.exe
) else (
	set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
)

echo Running sanity tests
node "%~dp0..\out\index.js" %*
