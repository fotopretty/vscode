/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import nls = require('vs/nls');
import {TPromise} from 'vs/base/common/winjs.base';
import URI from 'vs/base/common/uri';
import * as json from 'vs/base/common/json';
import * as encoding from 'vs/base/node/encoding';
import * as pfs from 'vs/base/node/pfs';
import {getConfigurationKeys} from 'vs/platform/configuration/common/model';
import {IWorkbenchEditorService} from 'vs/workbench/services/editor/common/editorService';
import {setProperty} from 'vs/base/common/jsonEdit';
import {applyEdits} from 'vs/base/common/jsonFormatter';
import {IWorkspaceContextService} from 'vs/platform/workspace/common/workspace';
import {IEnvironmentService} from 'vs/platform/environment/common/environment';
import {IConfigurationService} from 'vs/platform/configuration/common/configuration';
import {WORKSPACE_CONFIG_DEFAULT_PATH} from 'vs/workbench/services/configuration/common/configuration';
import {IConfigurationEditingService, ConfigurationEditingErrorCode, IConfigurationEditingError, ConfigurationTarget, IConfigurationValue} from 'vs/workbench/services/configuration/common/configurationEditing';

export const WORKSPACE_STANDALONE_CONFIGURATIONS = {
	'tasks': '.vscode/tasks.json',
	'launch': '.vscode/launch.json'
};

interface IConfigurationEditOperation extends IConfigurationValue {
	target: URI;
	isWorkspaceStandalone?: boolean;
}

interface IValidationResult {
	error?: ConfigurationEditingErrorCode;
	exists?: boolean;
	contents?: string;
}

export class ConfigurationEditingService implements IConfigurationEditingService {

	public _serviceBrand: any;

	constructor(
		@IConfigurationService private configurationService: IConfigurationService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService
	) {
	}

	public writeConfiguration(target: ConfigurationTarget, value: IConfigurationValue): TPromise<void> {
		const operation = this.getConfigurationEditOperation(target, value);

		// First validate before making any edits
		return this.validate(target, operation).then(validation => {
			if (typeof validation.error === 'number') {
				return this.wrapError(validation.error, target);
			}

			// Create configuration file if missing
			const resource = operation.target;
			let ensureConfigurationFile = TPromise.as(null);
			let contents: string;
			if (!validation.exists) {
				contents = '{}';
				ensureConfigurationFile = pfs.writeFile(resource.fsPath, contents, encoding.UTF8);
			} else {
				contents = validation.contents;
			}

			return ensureConfigurationFile.then(() => {

				// Apply all edits to the configuration file
				const result = this.applyEdits(contents, [operation]);

				return pfs.writeFile(resource.fsPath, result, encoding.UTF8).then(() => {

					// Reload the configuration so that we make sure all parties are updated
					return this.configurationService.reloadConfiguration().then(() => void 0);
				});
			});
		});
	}

	private wrapError(code: ConfigurationEditingErrorCode, target: ConfigurationTarget): TPromise<any> {
		const message = this.toErrorMessage(code, target);

		return TPromise.wrapError<IConfigurationEditingError>({
			code,
			message,
			toString: () => message
		});
	}

	private toErrorMessage(error: ConfigurationEditingErrorCode, target: ConfigurationTarget): string {
		switch (error) {

			// API constraints
			case ConfigurationEditingErrorCode.ERROR_UNKNOWN_KEY: return nls.localize('errorUnknownKey', "Unable to write to the configuration file (Unknown Key)");
			case ConfigurationEditingErrorCode.ERROR_INVALID_TARGET: return nls.localize('errorInvalidTarget', "Unable to write to the configuration file (Invalid Target)");
			case ConfigurationEditingErrorCode.ERROR_NO_WORKSPACE_OPENED: return nls.localize('errorWorkspaceOpened', "Unable to write to the workspace configuration file (No Workspace Opened)");

			// User issues
			case ConfigurationEditingErrorCode.ERROR_INVALID_CONFIGURATION: {
				if (target === ConfigurationTarget.USER) {
					return nls.localize('errorInvalidConfiguration', "Unable to write settings. Please open **User Settings** to correct errors/warnings in the file and try again.");
				}

				return nls.localize('errorInvalidConfigurationWorkspace', "Unable to write settings. Please open **Workspace Settings** to correct errors/warnings in the file and try again.");
			};
			case ConfigurationEditingErrorCode.ERROR_CONFIGURATION_FILE_DIRTY: {
				if (target === ConfigurationTarget.USER) {
					return nls.localize('errorConfigurationFileDirty', "Unable to write settings because the file is dirty. Please save the **User Settings** file and try again.");
				}

				return nls.localize('errorConfigurationFileDirtyWorkspace', "Unable to write settings because the file is dirty. Please save the **Workspace Settings** file and try again.");
			};
		}
	}

	private applyEdits(content: string, values: IConfigurationValue[]): string {
		const {tabSize, insertSpaces} = this.configurationService.getConfiguration<{ tabSize: number; insertSpaces: boolean }>('editor');
		const {eol} = this.configurationService.getConfiguration<{ eol: string }>('files');

		while (values.length > 0) {
			const {key, value} = values.pop();

			const edits = setProperty(content, [key], value, { tabSize, insertSpaces, eol });
			content = applyEdits(content, edits);
		}

		return content;
	}

	private validate(target: ConfigurationTarget, operation: IConfigurationEditOperation): TPromise<IValidationResult> {

		// Any key must be a known setting from the registry (unless this is a standalone config)
		if (!operation.isWorkspaceStandalone) {
			const validKeys = getConfigurationKeys();
			if (validKeys.indexOf(operation.key) < 0) {
				return TPromise.as({ error: ConfigurationEditingErrorCode.ERROR_UNKNOWN_KEY });
			}
		}

		// Target cannot be user if is standalone
		if (operation.isWorkspaceStandalone && target === ConfigurationTarget.USER) {
			return TPromise.as({ error: ConfigurationEditingErrorCode.ERROR_INVALID_TARGET });
		}

		// Target cannot be workspace if no workspace opened
		if (target === ConfigurationTarget.WORKSPACE && !this.contextService.getWorkspace()) {
			return TPromise.as({ error: ConfigurationEditingErrorCode.ERROR_NO_WORKSPACE_OPENED });
		}

		// Target cannot be dirty
		const resource = operation.target;
		return this.editorService.createInput({ resource }).then(typedInput => {
			if (typedInput.isDirty()) {
				return { error: ConfigurationEditingErrorCode.ERROR_CONFIGURATION_FILE_DIRTY };
			}

			// Target cannot contain JSON errors
			return pfs.exists(resource.fsPath).then(exists => {
				if (!exists) {
					return { exists };
				}

				return pfs.readFile(resource.fsPath).then(contentsRaw => {
					const contents = contentsRaw.toString(encoding.UTF8);
					const parseErrors = [];
					json.parse(contents, parseErrors);

					if (parseErrors.length > 0) {
						return { error: ConfigurationEditingErrorCode.ERROR_INVALID_CONFIGURATION };
					}

					return { exists, contents };
				});
			});
		});
	}

	private getConfigurationEditOperation(target: ConfigurationTarget, config: IConfigurationValue): IConfigurationEditOperation {

		// Check for standalone workspace configurations
		if (config.key) {
			const standaloneConfigurationKeys = Object.keys(WORKSPACE_STANDALONE_CONFIGURATIONS);
			for (let i = 0; i < standaloneConfigurationKeys.length; i++) {
				const key = standaloneConfigurationKeys[i];
				const keyPrefix = `${key}.`;
				const target = this.contextService.toResource(WORKSPACE_STANDALONE_CONFIGURATIONS[key]);

				if (config.key.indexOf(keyPrefix) === 0) {
					return { key: config.key.substr(keyPrefix.length), value: config.value, target, isWorkspaceStandalone: true };
				}
			}
		}

		if (target === ConfigurationTarget.USER) {
			return { key: config.key, value: config.value, target: URI.file(this.environmentService.appSettingsPath) };
		}

		return { key: config.key, value: config.value, target: this.contextService.toResource(WORKSPACE_CONFIG_DEFAULT_PATH) };
	}
}