# --------------------------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
# --------------------------------------------------------------------------------------------

# Shim script to ensure the GitHub Copilot CLI is installed and then run it.
# Used on Windows in terminal. Attempts installation via npm or winget.

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)

function Test-CommandExists {
    param([string]$Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Install-CopilotCLI {
    # Try npm
    if (Test-CommandExists 'npm') {
        Write-Host "Installing Copilot CLI via npm..."
        npm install -g @github/copilot
        if ($LASTEXITCODE -eq 0 -and (Test-CommandExists 'copilot')) {
            return $true
        }
    }

    # Try winget
    if (Test-CommandExists 'winget') {
        Write-Host "Installing Copilot CLI via winget..."
        winget install GitHub.Copilot --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -eq 0) {
            # Refresh PATH so the newly installed binary is found
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
            if (Test-CommandExists 'copilot') {
                return $true
            }
        }
    }

    return $false
}

# Check if copilot is already installed
if (-not (Test-CommandExists 'copilot')) {
    Write-Host "Copilot CLI not found. Attempting to install..."
    $installed = Install-CopilotCLI

    if (-not $installed) {
        Write-Error "Failed to install Copilot CLI. Please install it manually using one of:"
        Write-Error "  npm install -g @github/copilot"
        Write-Error "  winget install GitHub.Copilot"
        Write-Error "See https://github.com/github/copilot-cli for more installation options."
        exit 1
    }

    Write-Host "Copilot CLI installed successfully."
}

# Run copilot with the provided arguments
& copilot @Arguments
exit $LASTEXITCODE
