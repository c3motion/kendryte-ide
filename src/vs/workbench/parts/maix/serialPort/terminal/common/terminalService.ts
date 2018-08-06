/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as errors from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import {
	ISerialLaunchConfig,
	ISerialMonitorService,
	ISerialPortInstance,
	ISerialPortTab,
	ITerminalConfigHelper,
	ITerminalProcessExtHostProxy,
	ITerminalProcessExtHostRequest,
	KEYBINDING_CONTEXT_TERMINAL_FIND_WIDGET_VISIBLE,
	KEYBINDING_CONTEXT_TERMINAL_FOCUS,
	KEYBINDING_CONTEXT_TERMINAL_IS_OPEN,
	TERMINAL_PANEL_ID,
} from 'vs/workbench/parts/maix/serialPort/terminal/common/terminal';
import { TPromise } from 'vs/base/common/winjs.base';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';

const TERMINAL_STATE_STORAGE_KEY = 'terminal.state';

export abstract class TerminalService implements ISerialMonitorService {
	public _serviceBrand: any;

	protected _isShuttingDown: boolean;
	protected _terminalFocusContextKey: IContextKey<boolean>;
	protected _findWidgetVisible: IContextKey<boolean>;
	protected _terminalContainer: HTMLElement;
	protected _terminalTabs: ISerialPortTab[];
	protected abstract _terminalInstances: ISerialPortInstance[];

	private _activeTabIndex: number;

	public get activeTabIndex(): number { return this._activeTabIndex; }

	public get terminalInstances(): ISerialPortInstance[] { return this._terminalInstances; }

	public get terminalTabs(): ISerialPortTab[] { return this._terminalTabs; }

	private readonly _onActiveTabChanged: Emitter<void> = new Emitter<void>();
	public get onActiveTabChanged(): Event<void> { return this._onActiveTabChanged.event; }

	protected readonly _onInstanceCreated: Emitter<ISerialPortInstance> = new Emitter<ISerialPortInstance>();
	public get onInstanceCreated(): Event<ISerialPortInstance> { return this._onInstanceCreated.event; }

	protected readonly _onInstanceDisposed: Emitter<ISerialPortInstance> = new Emitter<ISerialPortInstance>();
	public get onInstanceDisposed(): Event<ISerialPortInstance> { return this._onInstanceDisposed.event; }

	protected readonly _onInstanceProcessIdReady: Emitter<ISerialPortInstance> = new Emitter<ISerialPortInstance>();
	public get onInstanceProcessIdReady(): Event<ISerialPortInstance> { return this._onInstanceProcessIdReady.event; }

	protected readonly _onInstanceRequestExtHostProcess: Emitter<ITerminalProcessExtHostRequest> = new Emitter<ITerminalProcessExtHostRequest>();
	public get onInstanceRequestExtHostProcess(): Event<ITerminalProcessExtHostRequest> { return this._onInstanceRequestExtHostProcess.event; }

	protected readonly _onInstanceDimensionsChanged: Emitter<ISerialPortInstance> = new Emitter<ISerialPortInstance>();
	public get onInstanceDimensionsChanged(): Event<ISerialPortInstance> { return this._onInstanceDimensionsChanged.event; }

	protected readonly _onInstancesChanged: Emitter<void> = new Emitter<void>();
	public get onInstancesChanged(): Event<void> { return this._onInstancesChanged.event; }

	protected readonly _onInstanceTitleChanged: Emitter<string> = new Emitter<string>();
	public get onInstanceTitleChanged(): Event<string> { return this._onInstanceTitleChanged.event; }

	protected readonly _onActiveInstanceChanged: Emitter<ISerialPortInstance> = new Emitter<ISerialPortInstance>();
	public get onActiveInstanceChanged(): Event<ISerialPortInstance> { return this._onActiveInstanceChanged.event; }

	protected readonly _onTabDisposed: Emitter<ISerialPortTab> = new Emitter<ISerialPortTab>();
	public get onTabDisposed(): Event<ISerialPortTab> { return this._onTabDisposed.event; }

	public abstract get configHelper(): ITerminalConfigHelper;

	constructor(
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IPanelService protected readonly _panelService: IPanelService,
		@IPartService private readonly _partService: IPartService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IStorageService protected readonly _storageService: IStorageService,
	) {
		this._activeTabIndex = 0;
		this._isShuttingDown = false;

		lifecycleService.onWillShutdown(event => event.veto(this._onWillShutdown()));
		lifecycleService.onShutdown(() => this._onShutdown());
		this._terminalFocusContextKey = KEYBINDING_CONTEXT_TERMINAL_FOCUS.bindTo(this._contextKeyService);
		this._findWidgetVisible = KEYBINDING_CONTEXT_TERMINAL_FIND_WIDGET_VISIBLE.bindTo(this._contextKeyService);
		this.onTabDisposed(tab => this._removeTab(tab));

		lifecycleService.when(LifecyclePhase.Restoring).then(() => this._restoreTabs());

		this._handleContextKeys();
	}

	private _handleContextKeys(): void {
		const terminalIsOpenContext = KEYBINDING_CONTEXT_TERMINAL_IS_OPEN.bindTo(this._contextKeyService);

		const updateTerminalContextKeys = () => {
			terminalIsOpenContext.set(this.terminalInstances.length > 0);
		};

		this.onInstancesChanged(() => updateTerminalContextKeys());
	}

	protected abstract _showTerminalCloseConfirmation(): TPromise<boolean>;

	public abstract createTerminal(shell?: ISerialLaunchConfig, wasNewTerminalAction?: boolean): ISerialPortInstance;

	public abstract createTerminalRenderer(name: string): ISerialPortInstance;

	public abstract createInstance(
		terminalFocusContextKey: IContextKey<boolean>,
		configHelper: ITerminalConfigHelper,
		container: HTMLElement,
		shellLaunchConfig: ISerialLaunchConfig,
		doCreateProcess: boolean,
	): ISerialPortInstance;

	public abstract getActiveOrCreateInstance(wasNewTerminalAction?: boolean): ISerialPortInstance;

	public abstract selectDefaultWindowsShell(): TPromise<string>;

	public abstract setContainers(panelContainer: HTMLElement, terminalContainer: HTMLElement): void;

	public abstract requestExtHostProcess(proxy: ITerminalProcessExtHostProxy, shellLaunchConfig: ISerialLaunchConfig, cols: number, rows: number): void;

	private _restoreTabs(): void {
		if (!this.configHelper.config.experimentalRestore) {
			return;
		}

		const tabConfigsJson = this._storageService.get(TERMINAL_STATE_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!tabConfigsJson) {
			return;
		}

		const tabConfigs = <{ instances: ISerialLaunchConfig[] }[]>JSON.parse(tabConfigsJson);
		if (!Array.isArray(tabConfigs)) {
			return;
		}

		tabConfigs.forEach(tabConfig => {
			const instance = this.createTerminal(tabConfig.instances[0]);
			if (!instance) {
				return;
			}
			for (let i = 1; i < tabConfig.instances.length; i++) {
				this.splitInstance(instance, tabConfig.instances[i]);
			}
		});
	}

	private _onWillShutdown(): boolean | TPromise<boolean> {
		if (this.terminalInstances.length === 0) {
			// No terminal instances, don't veto
			return false;
		}

		if (this.configHelper.config.confirmOnExit) {
			// veto if configured to show confirmation and the user choosed not to exit
			return this._showTerminalCloseConfirmation().then(veto => {
				if (!veto) {
					this._isShuttingDown = true;
				}
				return veto;
			});
		}

		this._isShuttingDown = true;

		return false;
	}

	private _onShutdown(): void {
		// Store terminal tab layout
		if (this.configHelper.config.experimentalRestore) {
			const configs = this.terminalTabs.map(tab => {
				return {
					instances: tab.terminalInstances.map(instance => instance.shellLaunchConfig),
				};
			});
			this._storageService.store(TERMINAL_STATE_STORAGE_KEY, JSON.stringify(configs), StorageScope.WORKSPACE);
		}

		// Dispose of all instances
		this.terminalInstances.forEach(instance => instance.dispose());
	}

	public getTabLabels(): string[] {
		return this._terminalTabs.filter(tab => tab.terminalInstances.length > 0).map((tab, index) => `${index + 1}: ${tab.title}`);
	}

	private _removeTab(tab: ISerialPortTab): void {
		// Get the index of the tab and remove it from the list
		const index = this._terminalTabs.indexOf(tab);
		const wasActiveTab = tab === this.getActiveTab();
		if (index !== -1) {
			this._terminalTabs.splice(index, 1);
		}

		// Adjust focus if the tab was active
		if (wasActiveTab && this._terminalTabs.length > 0) {
			// TODO: Only focus the new tab if the removed tab had focus?
			// const hasFocusOnExit = tab.activeInstance.hadFocusOnExit;
			const newIndex = index < this._terminalTabs.length ? index : this._terminalTabs.length - 1;
			this.setActiveTabByIndex(newIndex);
			this.getActiveInstance().focus(true);
		}

		// Hide the panel if there are no more instances, provided that VS Code is not shutting
		// down. When shutting down the panel is locked in place so that it is restored upon next
		// launch.
		if (this._terminalTabs.length === 0 && !this._isShuttingDown) {
			this.hidePanel();
			this._onActiveInstanceChanged.fire(undefined);
		}

		// Fire events
		this._onInstancesChanged.fire();
		if (wasActiveTab) {
			this._onActiveTabChanged.fire();
		}
	}

	public getActiveTab(): ISerialPortTab {
		if (this._activeTabIndex < 0 || this._activeTabIndex >= this._terminalTabs.length) {
			return null;
		}
		return this._terminalTabs[this._activeTabIndex];
	}

	public getActiveInstance(): ISerialPortInstance {
		const tab = this.getActiveTab();
		if (!tab) {
			return null;
		}
		return tab.activeInstance;
	}

	public getInstanceFromId(terminalId: number): ISerialPortInstance {
		return this.terminalInstances[this._getIndexFromId(terminalId)];
	}

	public getInstanceFromIndex(terminalIndex: number): ISerialPortInstance {
		return this.terminalInstances[terminalIndex];
	}

	public setActiveInstance(terminalInstance: ISerialPortInstance): void {
		this.setActiveInstanceByIndex(this._getIndexFromId(terminalInstance.id));
	}

	public setActiveTabByIndex(tabIndex: number): void {
		if (tabIndex >= this._terminalTabs.length) {
			return;
		}

		const didTabChange = this._activeTabIndex !== tabIndex;
		this._activeTabIndex = tabIndex;

		this._terminalTabs.forEach((t, i) => t.setVisible(i === this._activeTabIndex));
		if (didTabChange) {
			this._onActiveTabChanged.fire();
		}
	}

	private _getInstanceFromGlobalInstanceIndex(index: number): { tab: ISerialPortTab, tabIndex: number, instance: ISerialPortInstance, localInstanceIndex: number } {
		let currentTabIndex = 0;
		while (index >= 0 && currentTabIndex < this._terminalTabs.length) {
			const tab = this._terminalTabs[currentTabIndex];
			const count = tab.terminalInstances.length;
			if (index < count) {
				return {
					tab,
					tabIndex: currentTabIndex,
					instance: tab.terminalInstances[index],
					localInstanceIndex: index,
				};
			}
			index -= count;
			currentTabIndex++;
		}
		return null;
	}

	public setActiveInstanceByIndex(terminalIndex: number): void {
		const query = this._getInstanceFromGlobalInstanceIndex(terminalIndex);
		if (!query) {
			return;
		}

		query.tab.setActiveInstanceByIndex(query.localInstanceIndex);
		const didTabChange = this._activeTabIndex !== query.tabIndex;
		this._activeTabIndex = query.tabIndex;
		this._terminalTabs.forEach((t, i) => t.setVisible(i === query.tabIndex));

		// Only fire the event if there was a change
		if (didTabChange) {
			this._onActiveTabChanged.fire();
		}
	}

	public setActiveTabToNext(): void {
		if (this._terminalTabs.length <= 1) {
			return;
		}
		let newIndex = this._activeTabIndex + 1;
		if (newIndex >= this._terminalTabs.length) {
			newIndex = 0;
		}
		this.setActiveTabByIndex(newIndex);
	}

	public setActiveTabToPrevious(): void {
		if (this._terminalTabs.length <= 1) {
			return;
		}
		let newIndex = this._activeTabIndex - 1;
		if (newIndex < 0) {
			newIndex = this._terminalTabs.length - 1;
		}
		this.setActiveTabByIndex(newIndex);
	}

	public splitInstance(instanceToSplit: ISerialPortInstance, shellLaunchConfig: ISerialLaunchConfig = {}): void {
		const tab = this._getTabForInstance(instanceToSplit);
		if (!tab) {
			return;
		}

		const instance = tab.split(this._terminalFocusContextKey, this.configHelper, shellLaunchConfig);
		this._initInstanceListeners(instance);
		this._onInstancesChanged.fire();

		this._terminalTabs.forEach((t, i) => t.setVisible(i === this._activeTabIndex));
	}

	protected _initInstanceListeners(instance: ISerialPortInstance): void {
		instance.addDisposable(instance.onDisposed(this._onInstanceDisposed.fire, this._onInstanceDisposed));
		instance.addDisposable(instance.onTitleChanged(this._onInstanceTitleChanged.fire, this._onInstanceTitleChanged));
		instance.addDisposable(instance.onProcessIdReady(this._onInstanceProcessIdReady.fire, this._onInstanceProcessIdReady));
		instance.addDisposable(instance.onDimensionsChanged(() => this._onInstanceDimensionsChanged.fire(instance)));
		instance.addDisposable(instance.onFocus(this._onActiveInstanceChanged.fire, this._onActiveInstanceChanged));
	}

	private _getTabForInstance(instance: ISerialPortInstance): ISerialPortTab {
		for (let i = 0; i < this._terminalTabs.length; i++) {
			const tab = this._terminalTabs[i];
			if (tab.terminalInstances.indexOf(instance) !== -1) {
				return tab;
			}
		}
		return null;
	}

	public showPanel(focus?: boolean): TPromise<void> {
		return new TPromise<void>((complete) => {
			const panel = this._panelService.getActivePanel();
			if (!panel || panel.getId() !== TERMINAL_PANEL_ID) {
				return this._panelService.openPanel(TERMINAL_PANEL_ID, focus).then(() => {
					if (focus) {
						// Do the focus call asynchronously as going through the
						// command palette will force editor focus
						setTimeout(() => {
							const instance = this.getActiveInstance();
							if (instance) {
								instance.focus(true);
							}
						}, 0);
					}
					complete(void 0);
				});
			} else {
				if (focus) {
					// Do the focus call asynchronously as going through the
					// command palette will force editor focus
					setTimeout(() => {
						const instance = this.getActiveInstance();
						if (instance) {
							instance.focus(true);
						}
					}, 0);
				}
				complete(void 0);
			}
			return undefined;
		});
	}

	public hidePanel(): void {
		const panel = this._panelService.getActivePanel();
		if (panel && panel.getId() === TERMINAL_PANEL_ID) {
			this._partService.setPanelHidden(true).done(undefined, errors.onUnexpectedError);
		}
	}

	public abstract focusFindWidget(): TPromise<void>;

	public abstract hideFindWidget(): void;

	private _getIndexFromId(terminalId: number): number {
		let terminalIndex = -1;
		this.terminalInstances.forEach((terminalInstance, i) => {
			if (terminalInstance.id === terminalId) {
				terminalIndex = i;
			}
		});
		if (terminalIndex === -1) {
			throw new Error(`Terminal with ID ${terminalId} does not exist (has it already been disposed?)`);
		}
		return terminalIndex;
	}
}