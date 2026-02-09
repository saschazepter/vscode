/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { ResourceMap } from '../../../base/common/map.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ILogger, ILoggerOptions, isLogLevel, log, LogLevel } from '../common/log.js';
import { ILoggerMainService } from './loggerService.js';

function reviveUri(data: UriComponents | URI | undefined | null, context: string): URI {
	if (data && typeof data !== 'object') {
		throw new Error(`[LoggerChannel] Invalid URI data for '${context}': type=${typeof data}, value=${String(data).substring(0, 100)}`);
	}
	const result = URI.revive(data);
	if (!result) {
		throw new Error(`[LoggerChannel] Missing URI data for '${context}'`);
	}
	return result;
}

export class LoggerChannel implements IServerChannel {

	private readonly loggers = new ResourceMap<ILogger>();

	constructor(private readonly loggerService: ILoggerMainService) { }

	listen(_: unknown, event: string, windowId?: number): Event<any> {
		switch (event) {
			case 'onDidChangeLoggers': return windowId ? this.loggerService.getOnDidChangeLoggersEvent(windowId) : this.loggerService.onDidChangeLoggers;
			case 'onDidChangeLogLevel': return windowId ? this.loggerService.getOnDidChangeLogLevelEvent(windowId) : this.loggerService.onDidChangeLogLevel;
			case 'onDidChangeVisibility': return windowId ? this.loggerService.getOnDidChangeVisibilityEvent(windowId) : this.loggerService.onDidChangeVisibility;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call(_: unknown, command: string, arg?: any): Promise<any> {
		switch (command) {
			case 'createLogger': this.createLogger(reviveUri(arg[0], command), arg[1], arg[2]); return;
			case 'log': return this.log(reviveUri(arg[0], command), arg[1]);
			case 'consoleLog': return this.consoleLog(arg[0], arg[1]);
			case 'setLogLevel': return isLogLevel(arg[0]) ? this.loggerService.setLogLevel(arg[0]) : this.loggerService.setLogLevel(reviveUri(arg[0], command), arg[1]);
			case 'setVisibility': return this.loggerService.setVisibility(reviveUri(arg[0], command), arg[1]);
			case 'registerLogger': return this.loggerService.registerLogger({ ...arg[0], resource: reviveUri(arg[0].resource, command) }, arg[1]);
			case 'deregisterLogger': return this.loggerService.deregisterLogger(reviveUri(arg[0], command));
		}

		throw new Error(`Call not found: ${command}`);
	}

	private createLogger(file: URI, options: ILoggerOptions, windowId: number | undefined): void {
		this.loggers.set(file, this.loggerService.createLogger(file, options, windowId));
	}

	private consoleLog(level: LogLevel, args: any[]): void {
		let consoleFn = console.log;

		switch (level) {
			case LogLevel.Error:
				consoleFn = console.error;
				break;
			case LogLevel.Warning:
				consoleFn = console.warn;
				break;
			case LogLevel.Info:
				consoleFn = console.info;
				break;
		}

		consoleFn.call(console, ...args);
	}

	private log(file: URI, messages: [LogLevel, string][]): void {
		const logger = this.loggers.get(file);
		if (!logger) {
			throw new Error('Create the logger before logging');
		}
		for (const [level, message] of messages) {
			log(logger, level, message);
		}
	}
}

