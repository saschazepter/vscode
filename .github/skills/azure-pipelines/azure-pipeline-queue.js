#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Queue an Azure DevOps pipeline build for VS Code
 *
 * Usage:
 *   node scripts/azure-pipeline-queue.js [options]
 *
 * Options:
 *   --branch <name>       Source branch to build (default: current git branch)
 *   --definition <id>     Pipeline definition ID (default: 111)
 *   --variables <vars>    Pipeline variables in "KEY=value KEY2=value2" format
 *   --dry-run             Print the command without executing
 *   --help                Show this help message
 */

const { spawn, execSync } = require('child_process');

// Default configuration
const ORGANIZATION = 'https://dev.azure.com/monacotools';
const PROJECT = 'Monaco';
const DEFAULT_DEFINITION_ID = '111';

// Validation patterns
const NUMERIC_ID_PATTERN = /^\d+$/;
const MAX_ID_LENGTH = 15;
// Git branch names: alphanumeric, hyphens, underscores, slashes, dots (no shell metacharacters)
const BRANCH_PATTERN = /^[a-zA-Z0-9_\-./]+$/;
const MAX_BRANCH_LENGTH = 256;
// Pipeline variables: KEY=value format with safe characters
const VARIABLE_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*=[a-zA-Z0-9_\-./: ]*$/;
const MAX_VARIABLE_LENGTH = 256;

// Colors for output
const colors = {
	red: (/** @type {string} */ text) => `\x1b[0;31m${text}\x1b[0m`,
	green: (/** @type {string} */ text) => `\x1b[0;32m${text}\x1b[0m`,
	yellow: (/** @type {string} */ text) => `\x1b[0;33m${text}\x1b[0m`,
	blue: (/** @type {string} */ text) => `\x1b[0;34m${text}\x1b[0m`,
};

function printUsage() {
	const scriptName = 'node .github/skills/azure-pipelines/azure-pipeline-queue.js';
	console.log(`Usage: ${scriptName} [options]`);
	console.log('');
	console.log('Queue an Azure DevOps pipeline build for VS Code.');
	console.log('');
	console.log('Options:');
	console.log('  --branch <name>       Source branch to build (default: current git branch)');
	console.log('  --definition <id>     Pipeline definition ID (default: 111)');
	console.log('  --variables <vars>    Pipeline variables in "KEY=value KEY2=value2" format');
	console.log('  --dry-run             Print the command without executing');
	console.log('  --help                Show this help message');
	console.log('');
	console.log('Examples:');
	console.log(`  ${scriptName}                                    # Queue build on current branch`);
	console.log(`  ${scriptName} --branch my-feature                # Queue build on specific branch`);
	console.log(`  ${scriptName} --variables "SKIP_TESTS=true"      # Queue with custom variables`);
}

/**
 * Parse command line arguments
 * @param {string[]} args
 * @returns {{ branch: string, definitionId: string, variables: string, dryRun: boolean, help: boolean }}
 */
function parseArgs(args) {
	const result = {
		branch: '',
		definitionId: DEFAULT_DEFINITION_ID,
		variables: '',
		dryRun: false,
		help: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case '--branch':
				result.branch = args[++i] || '';
				break;
			case '--definition':
				result.definitionId = args[++i] || DEFAULT_DEFINITION_ID;
				break;
			case '--variables':
				result.variables = args[++i] || '';
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
 * Validate a branch name
 * @param {string} value
 */
function validateBranch(value) {
	if (!value) {
		return; // Empty values are handled elsewhere
	}
	if (value.length > MAX_BRANCH_LENGTH) {
		console.error(colors.red(`Error: --branch is too long (max ${MAX_BRANCH_LENGTH} characters)`));
		process.exit(1);
	}
	if (!BRANCH_PATTERN.test(value)) {
		console.error(colors.red('Error: --branch contains invalid characters'));
		console.log('Allowed: alphanumeric, hyphens, underscores, slashes, dots');
		process.exit(1);
	}
}

/**
 * Validate pipeline variables
 * @param {string} value
 */
function validateVariables(value) {
	if (!value) {
		return;
	}
	const vars = value.split(' ').filter(v => v.length > 0);
	for (const v of vars) {
		if (v.length > MAX_VARIABLE_LENGTH) {
			console.error(colors.red(`Error: Variable '${v.substring(0, 20)}...' is too long (max ${MAX_VARIABLE_LENGTH} characters)`));
			process.exit(1);
		}
		if (!VARIABLE_PATTERN.test(v)) {
			console.error(colors.red(`Error: Invalid variable format '${v}'`));
			console.log('Expected format: KEY=value (alphanumeric, underscores, hyphens, dots, slashes, colons, spaces in value)');
			process.exit(1);
		}
	}
}

/**
 * Validate all parsed arguments
 * @param {{ branch: string, definitionId: string, variables: string, dryRun: boolean, help: boolean }} args
 */
function validateArgs(args) {
	validateNumericId(args.definitionId, '--definition');
	validateBranch(args.branch);
	validateVariables(args.variables);
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
 * Get the current git branch
 * @returns {string}
 */
function getCurrentBranch() {
	try {
		return execSync('git branch --show-current', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
	} catch {
		return '';
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

	// Get current branch if not specified
	let branch = args.branch;
	if (!branch) {
		branch = getCurrentBranch();
		if (!branch) {
			console.error(colors.red('Error: Could not determine current git branch.'));
			console.log('Please specify a branch with --branch <name>');
			process.exit(1);
		}
		// Validate branch obtained from git as well
		validateBranch(branch);
	}

	// Build the command args
	const cmdArgs = [
		'pipelines', 'run',
		'--organization', ORGANIZATION,
		'--project', PROJECT,
		'--id', args.definitionId,
		'--branch', branch,
	];

	// Add variables if specified
	if (args.variables) {
		cmdArgs.push('--variables', ...args.variables.split(' '));
	}

	// Add output format
	cmdArgs.push('--output', 'json');

	console.log(colors.blue('Queueing Azure Pipeline Build'));
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(`Organization: ${colors.green(ORGANIZATION)}`);
	console.log(`Project:      ${colors.green(PROJECT)}`);
	console.log(`Definition:   ${colors.green(args.definitionId)}`);
	console.log(`Branch:       ${colors.green(branch)}`);
	if (args.variables) {
		console.log(`Variables:    ${colors.green(args.variables)}`);
	}
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log('');

	if (args.dryRun) {
		console.log(colors.yellow('Dry run - command would be:'));
		console.log(`az ${cmdArgs.join(' ')}`);
		process.exit(0);
	}

	// Execute the command
	console.log(colors.blue('Queuing build...'));

	try {
		const result = await runCommand('az', cmdArgs);
		const data = JSON.parse(result);

		const buildId = data.id;
		const buildNumber = data.buildNumber;
		const buildUrl = `${ORGANIZATION}/${PROJECT}/_build/results?buildId=${buildId}`;

		console.log('');
		console.log(colors.green('✓ Build queued successfully!'));
		console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
		console.log(`Build ID:     ${colors.green(buildId)}`);
		if (buildNumber) {
			console.log(`Build Number: ${colors.green(buildNumber)}`);
		}
		console.log(`URL:          ${colors.blue(buildUrl)}`);
		console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
		console.log('');
		console.log('To check status, run:');
		console.log(`  node .github/skills/azure-pipelines/azure-pipeline-status.js --build-id ${buildId}`);
		console.log('');
		console.log('To watch progress:');
		console.log(`  node .github/skills/azure-pipelines/azure-pipeline-status.js --build-id ${buildId} --watch`);
	} catch (e) {
		const error = e instanceof Error ? e : new Error(String(e));
		console.error(colors.red('Error queuing build:'));
		console.error(error.message);
		process.exit(1);
	}
}

main();
