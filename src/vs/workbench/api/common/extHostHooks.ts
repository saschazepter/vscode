/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ExtHostHooksShape } from './extHost.protocol.js';

export const IExtHostHooks = createDecorator<IExtHostHooks>('IExtHostHooks');

export interface IExtHostHooks extends ExtHostHooksShape {
}
