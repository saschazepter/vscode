#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Get status and logs of an Azure DevOps pipeline build
 *
 * Usage:
 *   node scripts/azure-pipeline-status.js [options]
 *
 * Options:
 *   --build-id <id>               Specific build ID (default: most recent on current branch)
 *   --definition <id>             Pipeline definition ID (default: 111)
 *   --watch [seconds]             Continuously poll status until build completes (default: 30)
 *   --download-log <id>           Download a specific log to /tmp
 *   --download-artifact <name>    Download artifact to /tmp
 *   --json                        Output raw JSON
 *   --help                        Show this help message
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Default configuration
const ORGANIZATION = 'https://dev.azure.com/monacotools';
const PROJECT = 'Monaco';
const DEFAULT_DEFINITION_ID = '111';
const DEFAULT_WATCH_INTERVAL = 30;

// Validation patterns
const NUMERIC_ID_PATTERN = /^\d+$/;
const MAX_ID_LENGTH = 15;
// Artifact names: alphanumeric, hyphens, underscores, dots (safe for filenames)
const ARTIFACT_NAME_PATTERN = /^[a-zA-Z0-9_\-.]+$/;
const MAX_ARTIFACT_NAME_LENGTH = 256;
const MIN_WATCH_INTERVAL = 5;
const MAX_WATCH_INTERVAL = 3600;

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
	cyan: (text) => `\x1b[0;36m${text}\x1b[0m`,
	/** @param {string} text */
	gray: (text) => `\x1b[0;90m${text}\x1b[0m`,
};

function printUsage() {
	const scriptName = 'node .github/skills/azure-pipelines/azure-pipeline-status.js';
	console.log(`Usage: ${scriptName} [options]`);
	console.log('');
	console.log('Get status and logs of an Azure DevOps pipeline build.');
	console.log('');
	console.log('Options:');
	console.log('  --build-id <id>       Specific build ID (default: list last 20 builds)');
	console.log('  --branch <name>       Filter builds by branch name (shows last 20 builds for branch)');
	console.log('  --reason <reason>     Filter builds by reason (manual, individualCI, batchedCI, schedule, pullRequest)');
	console.log('  --definition <id>     Pipeline definition ID (default: 111)');
	console.log('  --watch [seconds]     Continuously poll status until build completes (default: 30)');
	console.log('  --download-log <id>   Download a specific log to /tmp')
	console.log('  --download-artifact <name>  Download artifact to /tmp');
	console.log('  --json                Output raw JSON');
	console.log('  --help                Show this help message');
	console.log('');
	console.log('Examples:');
	console.log(`  ${scriptName}                              # List last 20 builds`);
	console.log(`  ${scriptName} --branch main                # List last 20 builds for main branch`);
	console.log(`  ${scriptName} --reason schedule            # List last 20 scheduled builds`);
	console.log(`  ${scriptName} --build-id 123456            # Status of specific build`);
	console.log(`  ${scriptName} --watch                      # Watch build until completion (30s interval)`);
	console.log(`  ${scriptName} --watch 60                   # Watch with 60s interval`);
	console.log(`  ${scriptName} --build-id 123456 --download-log 5  # Download log to /tmp`);
}

/**
 * @typedef {Object} Args
 * @property {string} buildId
 * @property {string} branch
 * @property {string} reason
 * @property {string} definitionId
 * @property {boolean} watch
 * @property {number} watchInterval
 * @property {string} downloadLog
 * @property {string} downloadArtifact
 * @property {boolean} jsonOutput
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
		branch: '',
		reason: '',
		definitionId: DEFAULT_DEFINITION_ID,
		watch: false,
		watchInterval: DEFAULT_WATCH_INTERVAL,
		downloadLog: '',
		downloadArtifact: '',
		jsonOutput: false,
		help: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case '--build-id':
				result.buildId = args[++i] || '';
				break;
			case '--branch':
				result.branch = args[++i] || '';
				break;
			case '--reason':
				result.reason = args[++i] || '';
				break;
			case '--definition':
				result.definitionId = args[++i] || DEFAULT_DEFINITION_ID;
				break;
			case '--watch':
				result.watch = true;
				// Check if next arg is a number (optional interval)
				if (args[i + 1] && /^\d+$/.test(args[i + 1])) {
					result.watchInterval = parseInt(args[++i], 10) || DEFAULT_WATCH_INTERVAL;
				}
				break;
			case '--download-log':
				result.downloadLog = args[++i] || '';
				break;
			case '--download-artifact':
				result.downloadArtifact = args[++i] || '';
				break;
			case '--json':
				result.jsonOutput = true;
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
 * Validate artifact name for safe file path usage
 * @param {string} value
 */
function validateArtifactName(value) {
	if (!value) {
		return;
	}
	if (value.length > MAX_ARTIFACT_NAME_LENGTH) {
		console.error(colors.red(`Error: --download-artifact name is too long (max ${MAX_ARTIFACT_NAME_LENGTH} characters)`));
		process.exit(1);
	}
	if (!ARTIFACT_NAME_PATTERN.test(value)) {
		console.error(colors.red('Error: --download-artifact name contains invalid characters'));
		console.log('Allowed: alphanumeric, hyphens, underscores, dots');
		process.exit(1);
	}
	// Prevent path traversal
	if (value.includes('..') || value.startsWith('.') || value.startsWith('/') || value.startsWith('\\')) {
		console.error(colors.red('Error: --download-artifact name contains unsafe path components'));
		process.exit(1);
	}
}

/**
 * Validate watch interval
 * @param {number} value
 */
function validateWatchInterval(value) {
	if (value < MIN_WATCH_INTERVAL || value > MAX_WATCH_INTERVAL) {
		console.error(colors.red(`Error: Watch interval must be between ${MIN_WATCH_INTERVAL} and ${MAX_WATCH_INTERVAL} seconds`));
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
	validateNumericId(args.downloadLog, '--download-log');
	validateArtifactName(args.downloadArtifact);
	if (args.watch) {
		validateWatchInterval(args.watchInterval);
	}
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

/**
 * Find the most recent build for a branch
 * @param {string} branch
 * @param {string} definitionId
 * @returns {Promise<string>}
 */
async function findRecentBuild(branch, definitionId) {
	try {
		const args = [
			'pipelines', 'build', 'list',
			'--organization', ORGANIZATION,
			'--project', PROJECT,
			'--definition-ids', definitionId,
			'--branch', branch,
			'--top', '1',
			'--query', '[0].id',
			'--output', 'tsv',
		];
		const result = await runCommand('az', args);
		return result.trim();
	} catch {
		return '';
	}
}

/**
 * @typedef {Object} BuildListItem
 * @property {number} id
 * @property {string} buildNumber
 * @property {string} status
 * @property {string} [result]
 * @property {string} [sourceBranch]
 * @property {string} [reason]
 * @property {string} [startTime]
 * @property {string} [finishTime]
 * @property {{ displayName?: string }} [requestedBy]
 * @property {{ displayName?: string }} [requestedFor]
 */

/**
 * Get list of recent builds
 * @param {string} definitionId
 * @param {number} top
 * @param {string} [branch]
 * @param {string} [reason]
 * @returns {Promise<BuildListItem[]>}
 */
async function getRecentBuilds(definitionId, top = 20, branch, reason) {
	try {
		const args = [
			'pipelines', 'build', 'list',
			'--organization', ORGANIZATION,
			'--project', PROJECT,
			'--definition-ids', definitionId,
			'--top', String(top),
			'--output', 'json',
		];
		if (branch) {
			args.push('--branch', branch);
		}
		if (reason) {
			args.push('--reason', reason);
		}
		const result = await runCommand('az', args);
		return JSON.parse(result);
	} catch {
		return [];
	}
}

/**
 * @typedef {Object} BuildStatus
 * @property {number} id
 * @property {string} buildNumber
 * @property {string} status
 * @property {string} [result]
 * @property {string} [sourceBranch]
 * @property {string} [startTime]
 * @property {string} [finishTime]
 * @property {{ displayName?: string }} [requestedBy]
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
 * @typedef {Object} TimelineRecord
 * @property {string} id
 * @property {string} [parentId]
 * @property {string} type
 * @property {string} [name]
 * @property {string} [state]
 * @property {string} [result]
 * @property {number} [order]
 * @property {{ id?: number }} [log]
 */

/**
 * @typedef {Object} Timeline
 * @property {TimelineRecord[]} records
 */

/**
 * Get build timeline
 * @param {string} buildId
 * @returns {Promise<Timeline|null>}
 */
async function getTimeline(buildId) {
	try {
		const timelineUrl = `${ORGANIZATION}/${PROJECT}/_apis/build/builds/${buildId}/timeline?api-version=7.0`;
		const args = ['rest', '--method', 'get', '--url', timelineUrl, '--resource', '499b84ac-1321-427f-aa17-267ca6975798'];
		const result = await runCommand('az', args);
		return JSON.parse(result);
	} catch {
		return null;
	}
}

/**
 * Get content of a specific log
 * @param {string} buildId
 * @param {string} logId
 * @returns {Promise<string>}
 */
/**
 * Download a specific log to /tmp
 * @param {string} buildId
 * @param {string} logId
 * @returns {Promise<string>} Path to downloaded file
 */
async function downloadLog(buildId, logId) {
	try {
		const logUrl = `${ORGANIZATION}/${PROJECT}/_apis/build/builds/${buildId}/logs/${logId}?api-version=7.0`;
		const args = ['rest', '--method', 'get', '--url', logUrl, '--resource', '499b84ac-1321-427f-aa17-267ca6975798'];
		const content = await runCommand('az', args);

		const tmpDir = os.tmpdir();
		const outputPath = path.join(tmpDir, `build-${buildId}-log-${logId}.txt`);

		console.log(colors.blue(`Downloading log #${logId}...`));
		console.log(colors.gray(`Destination: ${outputPath}`));

		fs.writeFileSync(outputPath, content);
		return outputPath;
	} catch (e) {
		throw new Error(`Failed to fetch log ${logId}: ${/** @type {Error} */(e).message}`);
	}
}

/**
 * @typedef {Object} Artifact
 * @property {string} name
 * @property {{ downloadUrl?: string, properties?: { artifactsize?: string } }} [resource]
 */

/**
 * Get build artifacts
 * @param {string} buildId
 * @returns {Promise<Artifact[]>}
 */
async function getBuildArtifacts(buildId) {
	try {
		const artifactsUrl = `${ORGANIZATION}/${PROJECT}/_apis/build/builds/${buildId}/artifacts?api-version=7.0`;
		const args = ['rest', '--method', 'get', '--url', artifactsUrl, '--resource', '499b84ac-1321-427f-aa17-267ca6975798'];
		const result = await runCommand('az', args);
		const response = JSON.parse(result);
		return response.value || [];
	} catch {
		return [];
	}
}

/**
 * Download an artifact to /tmp
 * @param {string} buildId
 * @param {string} artifactName
 * @returns {Promise<string>} Path to downloaded file
 */
async function downloadArtifact(buildId, artifactName) {
	const artifacts = await getBuildArtifacts(buildId);
	const artifact = artifacts.find((a) => a.name === artifactName);

	if (!artifact) {
		const available = artifacts.map((a) => a.name).join(', ');
		throw new Error(`Artifact '${artifactName}' not found. Available artifacts: ${available || 'none'}`);
	}

	const downloadUrl = artifact.resource?.downloadUrl;
	if (!downloadUrl) {
		throw new Error(`Artifact '${artifactName}' has no download URL`);
	}

	const tmpDir = os.tmpdir();
	const outputPath = path.join(tmpDir, `${artifactName}.zip`);

	console.log(colors.blue(`Downloading artifact '${artifactName}'...`));
	console.log(colors.gray(`Destination: ${outputPath}`));

	// Get access token for Azure DevOps
	const tokenArgs = ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '--query', 'accessToken', '--output', 'tsv'];
	const token = (await runCommand('az', tokenArgs)).trim();

	// Use fetch to download with the access token
	const response = await fetch(downloadUrl, {
		headers: { 'Authorization': `Bearer ${token}` },
		redirect: 'follow',
	});

	if (!response.ok) {
		throw new Error(`Failed to download artifact: ${response.status} ${response.statusText}`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	fs.writeFileSync(outputPath, buffer);

	return outputPath;
}

/**
 * Format status with color
 * @param {string} status
 * @returns {string}
 */
function formatStatus(status) {
	switch (status) {
		case 'completed':
			return colors.green('completed');
		case 'inProgress':
			return colors.blue('in progress');
		case 'notStarted':
			return colors.gray('not started');
		case 'cancelling':
		case 'postponed':
			return colors.yellow(status);
		default:
			return status || '';
	}
}

/**
 * Format result with color
 * @param {string} result
 * @returns {string}
 */
function formatResult(result) {
	switch (result) {
		case 'succeeded':
			return colors.green('✓ succeeded');
		case 'failed':
			return colors.red('✗ failed');
		case 'canceled':
			return colors.yellow('⊘ canceled');
		case 'partiallySucceeded':
			return colors.yellow('◐ partially succeeded');
		default:
			return result || 'pending';
	}
}

/**
 * Format timeline status icon
 * @param {string} state
 * @param {string} result
 * @returns {string}
 */
function formatTimelineStatus(state, result) {
	if (state === 'completed') {
		if (result === 'succeeded') {
			return colors.green('✓');
		}
		if (result === 'failed') {
			return colors.red('✗');
		}
		if (result === 'skipped') {
			return colors.gray('○');
		}
		return colors.yellow('◐');
	}
	if (state === 'inProgress') {
		return colors.blue('●');
	}
	return colors.gray('○');
}

/**
 * Display build summary
 * @param {BuildStatus} build
 */
function displayBuildSummary(build) {
	const id = build.id;
	const buildNumber = build.buildNumber;
	const status = build.status;
	const result = build.result;
	const sourceBranch = (build.sourceBranch || '').replace('refs/heads/', '');
	const startTime = build.startTime;
	const finishTime = build.finishTime;
	const requestedBy = build.requestedBy?.displayName;

	console.log('');
	console.log(colors.blue('Azure Pipeline Build Status'));
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(`Build ID:     ${colors.green(String(id))}`);
	console.log(`Build Number: ${colors.green(buildNumber)}`);
	console.log(`Branch:       ${colors.green(sourceBranch)}`);
	console.log(`Status:       ${formatStatus(status)}`);
	console.log(`Result:       ${formatResult(result || '')}`);
	if (requestedBy) {
		console.log(`Requested By: ${colors.cyan(requestedBy)}`);
	}
	if (startTime) {
		console.log(`Started:      ${colors.gray(startTime)}`);
	}
	if (finishTime) {
		console.log(`Finished:     ${colors.gray(finishTime)}`);
	}
	console.log(`URL:          ${colors.blue(`${ORGANIZATION}/${PROJECT}/_build/results?buildId=${id}`)}`);
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

/**
 * Display artifacts summary
 * @param {Artifact[]} artifacts
 */
function displayArtifacts(artifacts) {
	console.log('');
	console.log(colors.blue('Build Artifacts'));
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

	if (!artifacts || artifacts.length === 0) {
		console.log(colors.gray('No artifacts available'));
		console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
		return;
	}

	for (const artifact of artifacts) {
		const name = artifact.name || 'Unknown';
		const size = artifact.resource?.properties?.artifactsize;
		if (!size || parseInt(size, 10) === 0) {
			continue;
		}
		const sizeStr = ` (${formatBytes(parseInt(size, 10))})`;
		console.log(`  ${colors.cyan(name)}${colors.gray(sizeStr)}`);
	}

	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

/**
 * Display next steps hints
 * @param {string} buildId
 */
function displayNextSteps(buildId) {
	console.log('');
	console.log(colors.blue('Next Steps'));
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(colors.gray(`  Download artifact: --build-id ${buildId} --download-artifact <name>`));
	console.log(colors.gray(`  Download log:      --build-id ${buildId} --download-log <id>`));
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

/**
 * Format reason with readable text
 * @param {string} reason
 * @returns {string}
 */
function formatReason(reason) {
	switch (reason) {
		case 'manual':
			return 'Manual';
		case 'individualCI':
			return 'CI';
		case 'batchedCI':
			return 'Batched CI';
		case 'schedule':
			return 'Scheduled';
		case 'pullRequest':
			return 'PR';
		case 'buildCompletion':
			return 'Build Completion';
		case 'resourceTrigger':
			return 'Resource Trigger';
		default:
			return reason || 'Unknown';
	}
}

/**
 * Format relative time from a date string
 * @param {string} dateStr
 * @returns {string}
 */
function formatRelativeTime(dateStr) {
	if (!dateStr) {
		return '';
	}
	const date = new Date(dateStr);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) {
		return 'just now';
	}
	if (diffMins < 60) {
		return `${diffMins}m ago`;
	}
	if (diffHours < 24) {
		return `${diffHours}h ago`;
	}
	return `${diffDays}d ago`;
}

/**
 * Pad or truncate a string to a fixed width
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function padOrTruncate(str, width) {
	if (str.length > width) {
		return str.slice(0, width - 1) + '…';
	}
	return str.padEnd(width);
}

/**
 * Display a list of recent builds
 * @param {BuildListItem[]} builds
 */
function displayBuildList(builds) {
	console.log('');
	console.log(colors.blue('Recent Builds'));
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(colors.gray(`${'ID'.padEnd(10)} ${'Status'.padEnd(14)} ${'Reason'.padEnd(12)} ${'Branch'.padEnd(25)} ${'Requested By'.padEnd(20)} ${'Started'.padEnd(12)}`));
	console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────────────────');

	if (!builds || builds.length === 0) {
		console.log(colors.gray('No builds found'));
		console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
		return;
	}

	for (const build of builds) {
		const id = String(build.id).padEnd(10);
		const branch = padOrTruncate((build.sourceBranch || '').replace('refs/heads/', ''), 25);
		const requestedBy = padOrTruncate(build.requestedBy?.displayName || build.requestedFor?.displayName || 'Unknown', 20);
		const reason = padOrTruncate(formatReason(build.reason || ''), 12);
		const started = padOrTruncate(formatRelativeTime(build.startTime || ''), 12);

		// Format status/result
		let statusStr;
		if (build.status === 'completed') {
			switch (build.result) {
				case 'succeeded':
					statusStr = colors.green('✓ succeeded'.padEnd(14));
					break;
				case 'failed':
					statusStr = colors.red('✗ failed'.padEnd(14));
					break;
				case 'canceled':
					statusStr = colors.yellow('⊘ canceled'.padEnd(14));
					break;
				case 'partiallySucceeded':
					statusStr = colors.yellow('◐ partial'.padEnd(14));
					break;
				default:
					statusStr = colors.gray((build.result || 'unknown').padEnd(14));
			}
		} else if (build.status === 'inProgress') {
			statusStr = colors.blue('● in progress'.padEnd(14));
		} else if (build.status === 'notStarted') {
			statusStr = colors.gray('○ queued'.padEnd(14));
		} else if (build.status === 'cancelling') {
			statusStr = colors.yellow('⊘ cancelling'.padEnd(14));
		} else {
			statusStr = colors.gray((build.status || 'unknown').padEnd(14));
		}

		console.log(`${colors.cyan(id)} ${statusStr} ${reason} ${branch} ${requestedBy} ${colors.gray(started)}`);
	}

	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log('');
	console.log(colors.gray('Use --build-id <id> to see details for a specific build'));
}

/**
 * Format bytes to human readable string
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
	if (bytes === 0) {
		return '0 B';
	}
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Display timeline stages and jobs
 * @param {Timeline|null} timeline
 */
function displayTimeline(timeline) {
	console.log('');
	console.log(colors.blue('Pipeline Stages'));
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

	if (!timeline || !timeline.records) {
		console.log(colors.gray('Timeline not available'));
		console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
		return;
	}

	const records = timeline.records;
	const stages = records.filter((r) => r.type === 'Stage');
	const phases = records.filter((r) => r.type === 'Phase');
	const jobs = records.filter((r) => r.type === 'Job');

	// Build a map of phase IDs to their parent stage IDs
	const phaseToStage = new Map();
	for (const phase of phases) {
		if (phase.parentId) {
			phaseToStage.set(phase.id, phase.parentId);
		}
	}

	stages.sort((a, b) => (a.order || 0) - (b.order || 0));

	for (const stage of stages) {
		const status = formatTimelineStatus(stage.state || '', stage.result || '');
		const name = stage.name || 'Unknown';
		console.log(`${status} ${name}`);

		// Get phase IDs belonging to this stage
		const stagePhaseIds = new Set(phases.filter((p) => p.parentId === stage.id).map((p) => p.id));

		// Find jobs whose parent phase belongs to this stage
		const stageJobs = jobs.filter((j) => j.parentId && stagePhaseIds.has(j.parentId));

		stageJobs.sort((a, b) => (a.order || 0) - (b.order || 0));

		for (const job of stageJobs) {
			const jobStatus = formatTimelineStatus(job.state || '', job.result || '');
			const jobName = job.name || 'Unknown';
			const logId = job.log?.id;
			const logInfo = logId ? colors.gray(` (log #${logId})`) : '';
			console.log(`  ${jobStatus} ${jobName}${logInfo}`);
		}
	}

	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

/**
 * Clear console screen
 */
function clearScreen() {
	process.stdout.write('\x1Bc');
}

/**
 * Sleep for a number of seconds
 * @param {number} seconds
 * @returns {Promise<void>}
 */
function sleep(seconds) {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
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

	// If no build ID specified, show list of recent builds
	let buildId = args.buildId;
	if (!buildId && !args.downloadLog && !args.downloadArtifact && !args.watch) {
		const builds = await getRecentBuilds(args.definitionId, 20, args.branch, args.reason);

		if (args.jsonOutput) {
			console.log(JSON.stringify(builds, null, 2));
		} else {
			const filters = [];
			if (args.branch) {
				filters.push(`branch: ${args.branch}`);
			}
			if (args.reason) {
				filters.push(`reason: ${args.reason}`);
			}
			if (filters.length > 0) {
				console.log(colors.gray(`Filtering by ${filters.join(', ')}`));
			}
			displayBuildList(builds);
		}
		return;
	}

	// For watch mode or download operations without a build ID, find the most recent build on current branch
	if (!buildId) {
		const branch = getCurrentBranch();
		if (!branch) {
			console.error(colors.red('Error: Could not determine current git branch.'));
			console.log('Please specify a build ID with --build-id <id>');
			process.exit(1);
		}

		console.log(colors.gray(`Finding most recent build for branch: ${branch}`));
		buildId = await findRecentBuild(branch, args.definitionId);

		if (!buildId) {
			console.error(colors.red(`Error: No builds found for branch '${branch}'.`));
			console.log('You can queue a new build with: node .github/skills/azure-pipelines/azure-pipeline-queue.js');
			process.exit(1);
		}
	}

	// Download specific log
	if (args.downloadLog) {
		try {
			const outputPath = await downloadLog(buildId, args.downloadLog);
			console.log(colors.green(`✓ Log downloaded to: ${outputPath}`));
		} catch (e) {
			console.error(colors.red(/** @type {Error} */(e).message));
			process.exit(1);
		}
		return;
	}

	// Download artifact
	if (args.downloadArtifact) {
		try {
			const outputPath = await downloadArtifact(buildId, args.downloadArtifact);
			console.log(colors.green(`✓ Artifact downloaded to: ${outputPath}`));
		} catch (e) {
			console.error(colors.red(/** @type {Error} */(e).message));
			process.exit(1);
		}
		return;
	}

	// Watch mode
	if (args.watch) {
		console.log(colors.blue(`Watching build ${buildId} (Ctrl+C to stop)`));
		console.log('');

		while (true) {
			const build = await getBuildStatus(buildId);

			if (!build) {
				console.error(colors.red('Error: Could not fetch build status'));
				process.exit(1);
			}

			clearScreen();

			if (args.jsonOutput) {
				console.log(JSON.stringify(build, null, 2));
			} else {
				displayBuildSummary(build);
				const timeline = await getTimeline(buildId);
				displayTimeline(timeline);

				const artifacts = await getBuildArtifacts(buildId);
				displayArtifacts(artifacts);
				displayNextSteps(buildId);
			}

			// Check if build is complete
			if (build.status === 'completed') {
				console.log('');
				console.log(colors.green('Build completed!'));
				process.exit(0);
			}

			console.log('');
			console.log(colors.gray(`Refreshing in ${args.watchInterval} seconds... (Ctrl+C to stop)`));
			await sleep(args.watchInterval);
		}
	} else {
		// Single status check
		const build = await getBuildStatus(buildId);

		if (!build) {
			console.error(colors.red(`Error: Could not fetch build status for ID ${buildId}`));
			process.exit(1);
		}

		if (args.jsonOutput) {
			console.log(JSON.stringify(build, null, 2));
		} else {
			displayBuildSummary(build);
			const timeline = await getTimeline(buildId);
			displayTimeline(timeline);

			const artifacts = await getBuildArtifacts(buildId);
			displayArtifacts(artifacts);
			displayNextSteps(buildId);
		}
	}
}

main();
