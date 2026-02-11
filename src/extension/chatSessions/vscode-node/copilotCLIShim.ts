/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Shim script to ensure the GitHub Copilot CLI is installed and then run it.
// Used on Linux/Mac in terminal. Attempts installation via npm, brew, curl, or wget.

import { execSync, spawn } from 'child_process';

function commandExists(command: string): boolean {
	try {
		execSync(`command -v ${command}`, { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

function tryInstall(label: string, installCommand: string): boolean {
	console.log(`Installing Copilot CLI via ${label}...`);
	try {
		execSync(installCommand, { stdio: 'inherit' });
		return commandExists('copilot');
	} catch {
		return false;
	}
}

function installCopilotCLI(): boolean {
	// Try npm
	if (commandExists('npm')) {
		if (tryInstall('npm', 'npm install -g @github/copilot')) {
			return true;
		}
	}

	// Try brew
	if (commandExists('brew')) {
		if (tryInstall('brew', 'brew install copilot-cli')) {
			return true;
		}
	}

	// Try curl
	if (commandExists('curl')) {
		if (tryInstall('curl', 'curl -fsSL https://gh.io/copilot-install | bash')) {
			return true;
		}
	}

	// Try wget
	if (commandExists('wget')) {
		if (tryInstall('wget', 'wget -qO- https://gh.io/copilot-install | bash')) {
			return true;
		}
	}

	return false;
}

// Main entry point
if (!commandExists('copilot')) {
	console.log('Copilot CLI not found. Attempting to install...');

	if (!installCopilotCLI()) {
		console.error('Failed to install Copilot CLI. Please install it manually using one of:');
		console.error('  npm install -g @github/copilot');
		console.error('  brew install copilot-cli');
		console.error('  curl -fsSL https://gh.io/copilot-install | bash');
		console.error('See https://github.com/github/copilot-cli for more installation options.');
		process.exit(1);
	}

	console.log('Copilot CLI installed successfully.');
}

// Run copilot with the provided arguments
const args = process.argv.slice(2);
const copilotProcess = spawn('copilot', args, { stdio: 'inherit' });

copilotProcess.on('error', (err) => {
	console.error(`Failed to start Copilot CLI: ${err.message}`);
	process.exit(1);
});

copilotProcess.on('exit', (code) => {
	process.exit(code ?? 0);
});
