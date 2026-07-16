/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Project } from '@typescript/native/unstable/async';
import {
	SyntaxKind,
	isArrowFunction,
	isClassDeclaration,
	isConstructorDeclaration,
	isFunctionDeclaration,
	isFunctionExpression,
	isGetAccessorDeclaration,
	isMethodDeclaration,
	isModuleDeclaration,
	isSetAccessorDeclaration,
	isSourceFile,
	type Node,
	type SourceFile,
} from '@typescript/native/unstable/ast';
import { CompilerOptionsRunnable } from './baseContextProviders';
import { ClassContextProvider } from './classContextProvider';
import { ContextProvider, ContextRunnableCollector, type ComputeContextSession, type ContextProviderFactory, type ContextResult, type ContextRunnable, type ProviderComputeContext, type RequestContext } from './contextProvider';
import { FunctionContextProvider } from './functionContextProvider';
import { AccessorProvider, ConstructorContextProvider, MethodContextProvider } from './methodContextProvider';
import { ModuleContextProvider } from './moduleContextProvider';
import { SourceFileContextProvider } from './sourceFileContextProvider';
import { RecoverableError } from './types';
import tss, { type CancellationTokenWithTimer } from './typescripts';

class ProviderComputeContextImpl implements ProviderComputeContext {
	private firstCallableProvider: ContextProvider | undefined;

	public update(contextProvider: ContextProvider): ContextProvider {
		if (this.firstCallableProvider === undefined && contextProvider.isCallableProvider === true) {
			this.firstCallableProvider = contextProvider;
		}
		return contextProvider;
	}

	public isFirstCallableProvider(contextProvider: ContextProvider): boolean {
		return this.firstCallableProvider === contextProvider;
	}
}

class ContextProviders {
	private static readonly Factories = new Map<SyntaxKind, ContextProviderFactory>([
		[SyntaxKind.SourceFile, (_node, tokenInfo, computeContext) => new SourceFileContextProvider(tokenInfo, computeContext)],
		[SyntaxKind.FunctionDeclaration, (node, tokenInfo, computeContext) => isFunctionDeclaration(node) ? new FunctionContextProvider(node, tokenInfo, computeContext) : undefined],
		[SyntaxKind.ArrowFunction, (node, tokenInfo, computeContext) => isArrowFunction(node) ? new FunctionContextProvider(node, tokenInfo, computeContext) : undefined],
		[SyntaxKind.FunctionExpression, (node, tokenInfo, computeContext) => isFunctionExpression(node) ? new FunctionContextProvider(node, tokenInfo, computeContext) : undefined],
		[SyntaxKind.GetAccessor, (node, tokenInfo, computeContext) => isGetAccessorDeclaration(node) ? new AccessorProvider(node, tokenInfo, computeContext) : undefined],
		[SyntaxKind.SetAccessor, (node, tokenInfo, computeContext) => isSetAccessorDeclaration(node) ? new AccessorProvider(node, tokenInfo, computeContext) : undefined],
		[SyntaxKind.ClassDeclaration, (node, tokenInfo) => isClassDeclaration(node) ? ClassContextProvider.create(node, tokenInfo) : undefined],
		[SyntaxKind.Constructor, (node, tokenInfo, computeContext) => isConstructorDeclaration(node) ? new ConstructorContextProvider(node, tokenInfo, computeContext) : undefined],
		[SyntaxKind.MethodDeclaration, (node, tokenInfo, computeContext) => isMethodDeclaration(node) ? new MethodContextProvider(node, tokenInfo, computeContext) : undefined],
		[SyntaxKind.ModuleDeclaration, (node, tokenInfo, computeContext) => isModuleDeclaration(node) ? new ModuleContextProvider(node, tokenInfo, computeContext) : undefined],
	]);

	private readonly tokenInfo: tss.TokenInfo;
	private readonly computeInfo: ProviderComputeContextImpl = new ProviderComputeContextImpl();

	constructor(tokenInfo: tss.TokenInfo) {
		this.tokenInfo = tokenInfo;
	}

	public async execute(result: ContextResult, session: ComputeContextSession, project: Project, token: CancellationTokenWithTimer): Promise<void> {
		const collector = await this.getContextRunnables(session, project, result.context, token);
		result.addPath(tss.StableSyntaxKinds.getPath(this.tokenInfo.touching ?? this.tokenInfo.token));
		for (const runnable of collector.entries()) {
			runnable.initialize(result);
		}
		await this.executeRunnables(collector.getPrimaryRunnables(), result, token);
		await this.executeRunnables(collector.getSecondaryRunnables(), result, token);
		await this.executeRunnables(collector.getTertiaryRunnables(), result, token);
		result.done();
	}

	private async executeRunnables(runnables: ContextRunnable[], result: ContextResult, token: CancellationTokenWithTimer): Promise<void> {
		for (const runnable of runnables) {
			token.throwIfCancellationRequested();
			try {
				await runnable.compute(token);
			} catch (error) {
				if (error instanceof RecoverableError) {
					result.addErrorData(error);
				} else {
					throw error;
				}
			}
		}
	}

	private async getContextRunnables(session: ComputeContextSession, project: Project, context: RequestContext, token: CancellationTokenWithTimer): Promise<ContextRunnableCollector> {
		const result = new ContextRunnableCollector(context.clientSideRunnableResults);
		result.addPrimary(new CompilerOptionsRunnable(session, project, context, this.tokenInfo.token.getSourceFile()));
		for (const provider of this.computeProviders()) {
			await provider.provide(result, session, project, context, token);
		}
		return result;
	}

	private computeProviders(): ContextProvider[] {
		const result: ContextProvider[] = [];
		let token: Node | undefined = this.tokenInfo.touching;
		if (token === undefined) {
			token = this.tokenInfo.token.kind === SyntaxKind.EndOfFile ? this.tokenInfo.previous : this.tokenInfo.token;
		}
		if (token === undefined || token.kind === SyntaxKind.EndOfFile) {
			return result;
		}
		let current: Node | undefined = token;
		while (current !== undefined) {
			const factory = ContextProviders.Factories.get(current.kind);
			const provider = factory?.(current, this.tokenInfo, this.computeInfo);
			if (provider !== undefined) {
				result.push(this.computeInfo.update(provider));
			}
			if (isSourceFile(current)) {
				break;
			}
			current = current.parent;
		}
		return result;
	}
}

export async function computeContext(result: ContextResult, session: ComputeContextSession, project: Project, document: SourceFile, position: number, token: CancellationTokenWithTimer): Promise<void> {
	const sourceFile = await project.program.getSourceFile(document.fileName);
	if (sourceFile === undefined) {
		result.addErrorData(new RecoverableError('No source file found for document', RecoverableError.NoSourceFile));
		return;
	}
	const tokenInfo = tss.getRelevantTokens(sourceFile, position);
	await new ContextProviders(tokenInfo).execute(result, session, project, token);
}