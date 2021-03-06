/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import {IDisposable, dispose} from 'vs/base/common/lifecycle';
import {IPanelService} from 'vs/workbench/services/panel/common/panelService';
import {IPartService} from 'vs/workbench/services/part/common/partService';
import {ITerminalService, ITerminalInstance} from 'vs/workbench/parts/terminal/electron-browser/terminal';
import {IThreadService} from 'vs/workbench/services/thread/common/threadService';
import {TPromise} from 'vs/base/common/winjs.base';
import {ExtHostContext, ExtHostTerminalServiceShape, MainThreadTerminalServiceShape} from './extHost.protocol';

export class MainThreadTerminalService extends MainThreadTerminalServiceShape {

	private _proxy: ExtHostTerminalServiceShape;
	private _toDispose: IDisposable[];

	constructor(
		@IPanelService private panelService: IPanelService,
		@IPartService private partService: IPartService,
		@IThreadService private threadService: IThreadService,
		@ITerminalService private terminalService: ITerminalService
	) {
		super();
		this._proxy = threadService.get(ExtHostContext.ExtHostTerminalService);
		this._toDispose = [];
		this._toDispose.push(terminalService.onInstanceDisposed((terminalInstance) => this._onTerminalDisposed(terminalInstance)));
	}

	public dispose(): void {
		this._toDispose = dispose(this._toDispose);
	}

	public $createTerminal(name?: string, shellPath?: string, shellArgs?: string[]): TPromise<number> {
		return TPromise.as(this.terminalService.createInstance(name, shellPath, shellArgs).id);
	}

	public $show(terminalId: number, preserveFocus: boolean): void {
		let terminalInstance = this.terminalService.getInstanceFromId(terminalId);
		if (terminalInstance) {
			this.terminalService.setActiveInstance(terminalInstance);
			this.terminalService.showPanel(!preserveFocus);
		}
	}

	public $hide(terminalId: number): void {
		if (this.terminalService.getActiveInstance().id === terminalId) {
			this.terminalService.hidePanel();
		}
	}

	public $dispose(terminalId: number): void {
		let terminalInstance = this.terminalService.getInstanceFromId(terminalId);
		if (terminalInstance) {
			terminalInstance.dispose();
		}
	}

	public $sendText(terminalId: number, text: string, addNewLine: boolean): void {
		let terminalInstance = this.terminalService.getInstanceFromId(terminalId);
		if (terminalInstance) {
			terminalInstance.sendText(text, addNewLine);
		}
	}

	private _onTerminalDisposed(terminalInstance: ITerminalInstance): void {
		this._proxy.$acceptTerminalClosed(terminalInstance.id);
	}
}
