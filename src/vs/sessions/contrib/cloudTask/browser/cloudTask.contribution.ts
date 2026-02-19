/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ICloudTaskService } from '../../../../platform/cloudTask/common/cloudTaskService.js';
import { CloudTaskService } from '../../../../platform/cloudTask/browser/cloudTaskService.js';

registerSingleton(ICloudTaskService, CloudTaskService, InstantiationType.Delayed);
