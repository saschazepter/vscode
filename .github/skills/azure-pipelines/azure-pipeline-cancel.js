#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Cancel a running Azure DevOps pipeline build
 *
 * Usage:
 *   node scripts/azure-pipeline-cancel.js --build-id <id> [options]
 *
 * Options:
 *   --build-id <id>       Build ID to cancel (required)
 *   --definition <id>     Pipeline definition ID (default: 111)
 *   --dry-run             Print the command without executing
 *   --help                Show this help message
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Default configuration
const ORGANIZATION = 'https://dev.azure.com/monacotools';
const PROJECT = 'Monaco';
const DEFAULT_DEFINITION_ID = '111';

// Validation patterns
const NUMERIC_ID_PATTERN = /^\d+$/;
const MAX_ID_LENGTH = 15;

// Colors for output
const colors = {
	/** @param {string} text */
	red: (text) => `\x1b[0;31m${text}\x1b[0m`,
	/** @param {string} text */
	green: (text) => `\x1b[0;32m${text}\x1b[0m`,
	/** @param {string} text */
	yellow: (text) => `\x1b[0;33m${text}\x1b[0m`,
	/** @param {string} text */
	blue: (text) => `\x1b[0;34m${text}\x1b[0m`,
	/** @param {string} text */
	gray: (text) => `\x1b[0;90m${text}\x1b[0m`,
};

function printUsage() {
	const scriptName = 'node .github/skills/azure-pipelines/azure-pipeline-cancel.js';
	console.log(`Usage: ${scriptName} --build-id <id> [options]`);
	console.log('');
	console.log('Cancel a running Azure DevOps pipeline build.');
	console.log('');
	console.log('Options:');
	console.log('  --build-id <id>       Build ID to cancel (required)');
	console.log('  --definition <id>     Pipeline definition ID (default: 111)');
	console.log('  --dry-run             Print what would be cancelled without executing');
	console.log('  --help                Show this help message');
	console.log('');
	console.log('Examples:');
	console.log(`  ${scriptName} --build-id 123456      # Cancel specific build`);
	console.log(`  ${scriptName} --build-id 123456 --dry-run  # Show what would be cancelled`);
}

/**
 * @typedef {Object} Args
 * @property {string} buildId
 * @property {string} definitionId
 * @property {boolean} dryRun
 * @property {boolean} help
 */

/**
 * Parse command line arguments
 * @param {string[]} args
 * @returns {Args}
 */
function parseArgs(args) {
	/** @type {Args} */
	const result = {
		buildId: '',
		definitionId: DEFAULT_DEFINITION_ID,
		dryRun: false,
		help: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case '--build-id':
				result.buildId = args[++i] || '';
				break;
			case '--definition':
				result.definitionId = args[++i] || DEFAULT_DEFINITION_ID;
				break;
			case '--dry-run':
				result.dryRun = true;
				break;
			case '--help':
				result.help = true;
				break;
			default:
				console.error(colors.red(`Error: Unknown option: ${arg}`));
				printUsage();
				process.exit(1);
		}
	}

	return result;
}

/**
 * Validate a numeric ID argument
 * @param {string} value
 * @param {string} name
 */
function validateNumericId(value, name) {
	if (!value) {
		return; // Empty values are handled elsewhere
	}
	if (value.length > MAX_ID_LENGTH) {
		console.error(colors.red(`Error: ${name} is too long (max ${MAX_ID_LENGTH} characters)`));
		process.exit(1);
	}
	if (!NUMERIC_ID_PATTERN.test(value)) {
		console.error(colors.red(`Error: ${name} must contain only digits`));
		process.exit(1);
	}
}

/**
 * Validate all parsed arguments
 * @param {Args} args
 */
function validateArgs(args) {
	validateNumericId(args.buildId, '--build-id');
	validateNumericId(args.definitionId, '--definition');
}

/**
 * Check if a command exists
 * @param {string} command
 * @returns {boolean}
 */
function commandExists(command) {
	try {
		execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${command}`, { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if Azure DevOps extension is installed
 * @returns {boolean}
 */
function hasAzureDevOpsExtension() {
	try {
		execSync('az extension show --name azure-devops', { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

/**
 * Run a command and return the output
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function runCommand(command, args) {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { shell: true });
		let stdout = '';
		let stderr = '';

		proc.stdout.on('data', (data) => {
			stdout += data.toString();
		});

		proc.stderr.on('data', (data) => {
			stderr += data.toString();
		});

		proc.on('close', (code) => {
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(stderr || stdout || `Command failed with code ${code}`));
			}
		});

		proc.on('error', reject);
	});
}

/**
 * @typedef {Object} BuildStatus
 * @property {number} id
 * @property {string} buildNumber
 * @property {string} status
 * @property {string} [result]
 * @property {string} [sourceBranch]
 */

/**
 * Get build status
 * @param {string} buildId
 * @returns {Promise<BuildStatus|null>}
 */
async function getBuildStatus(buildId) {
	try {
		const args = [
			'pipelines', 'build', 'show',
			'--organization', ORGANIZATION,
			'--project', PROJECT,
			'--id', buildId,
			'--output', 'json',
		];
		const result = await runCommand('az', args);
		return JSON.parse(result);
	} catch {
		return null;
	}
}

/**
 * Cancel a build using Azure DevOps REST API
 * @param {string} buildId
 * @returns {Promise<BuildStatus>}
 */
async function cancelBuild(buildId) {
	const url = `${ORGANIZATION}/${PROJECT}/_apis/build/builds/${buildId}?api-version=7.0`;
	const body = JSON.stringify({ status: 'cancelling' });

	// Write body to temp file to avoid shell escaping issues
	const tmpDir = os.tmpdir();
	const bodyFile = path.join(tmpDir, `cancel-build-${buildId}.json`);
	fs.writeFileSync(bodyFile, body);

	try {
		const args = [
			'rest',
			'--method', 'patch',
			'--url', url,
			'--resource', '499b84ac-1321-427f-aa17-267ca6975798',
			'--headers', 'Content-Type=application/json',
			'--body', `@${bodyFile}`,
		];

		const result = await runCommand('az', args);
		return JSON.parse(result);
	} finally {
		// Clean up temp file
		try {
			fs.unlinkSync(bodyFile);
		} catch {
			// Ignore cleanup errors
		}
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		printUsage();
		process.exit(0);
	}

	// Validate arguments before using them
	validateArgs(args);

	// Check for Azure CLI
	if (!commandExists('az')) {
		console.error(colors.red('Error: Azure CLI (az) is not installed.'));
		console.log('Install it with: brew install azure-cli (macOS) or see https://docs.microsoft.com/en-us/cli/azure/install-azure-cli');
		console.log('Then add the DevOps extension: az extension add --name azure-devops');
		process.exit(1);
	}

	// Check for azure-devops extension
	if (!hasAzureDevOpsExtension()) {
		console.log(colors.yellow('Installing azure-devops extension...'));
		try {
			execSync('az extension add --name azure-devops', { stdio: 'inherit' });
		} catch {
			console.error(colors.red('Failed to install azure-devops extension.'));
			process.exit(1);
		}
	}

	// Require build ID
	const buildId = args.buildId;

	if (!buildId) {
		console.error(colors.red('Error: --build-id is required.'));
		console.log('');
		console.log('To find build IDs, run:');
		console.log('  node .github/skills/azure-pipelines/azure-pipeline-status.js');
		process.exit(1);
	}

	// Get current build status
	const build = await getBuildStatus(buildId);

	if (!build) {
		console.error(colors.red(`Error: Could not fetch build status for ID ${buildId}`));
		process.exit(1);
	}

	const buildUrl = `${ORGANIZATION}/${PROJECT}/_build/results?buildId=${buildId}`;

	console.log('');
	console.log(colors.blue('Azure Pipeline Build Cancel'));
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(`Build ID:     ${colors.green(String(build.id))}`);
	console.log(`Build Number: ${colors.green(build.buildNumber || 'N/A')}`);
	console.log(`Status:       ${colors.yellow(build.status)}`);
	console.log(`URL:          ${colors.blue(buildUrl)}`);
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

	// Check if build can be cancelled
	if (build.status === 'completed') {
		console.log('');
		console.log(colors.yellow('Build is already completed. Nothing to cancel.'));
		process.exit(0);
	}

	if (build.status === 'cancelling') {
		console.log('');
		console.log(colors.yellow('Build is already being cancelled.'));
		process.exit(0);
	}

	if (args.dryRun) {
		console.log('');
		console.log(colors.yellow('Dry run - would cancel build:'));
		console.log(`  Build ID: ${buildId}`);
		console.log(`  API: PATCH ${ORGANIZATION}/${PROJECT}/_apis/build/builds/${buildId}?api-version=7.0`);
		console.log(`  Body: {"status": "cancelling"}`);
		process.exit(0);
	}

	// Cancel the build
	console.log('');
	console.log(colors.blue('Cancelling build...'));

	try {
		await cancelBuild(buildId);
		console.log('');
		console.log(colors.green('✓ Build cancellation requested successfully!'));
		console.log('');
		console.log('The build will transition to "cancelling" state and then "canceled".');
		console.log('Check status with:');
		console.log(`  node .github/skills/azure-pipelines/azure-pipeline-status.js --build-id ${buildId}`);
	} catch (e) {
		const error = e instanceof Error ? e : new Error(String(e));
		console.error('');
		console.error(colors.red('Error cancelling build:'));
		console.error(error.message);
		process.exit(1);
	}
}

main();
