import React, { Component, ChangeEvent } from 'react';
import JSZip from "jszip";
import XmlConverter from 'xml-js';
import * as marky from "marky"

import Favorite from "./classes/Favorite";
import FileForm from "./components/FileForm";
import PagesView from "./components/PagesView";
import LauncherApp from './classes/LauncherApp';
import Screen from './classes/Screen';
import LauncherDatabase from "./classes/LauncherDatabase";
import AppIcon from "./components/AppIcon";

enum LoadState {
	NONE,
	LOADING,
	LOADED
}

class AppState {
	outdatedBrowser = false;

	loadState: LoadState = LoadState.NONE;
	screens: Map<number, Screen> = new Map();
	favorites: Map<number, Favorite> = new Map();
	rows = 0;
	cols = 0;
	dockCols = 0;
	defaultScreen?: number = 0;
}

class App extends Component<{}, AppState> {
	private worker: Worker;
	private prefs: XmlConverter.Element;
	private applist: Map<string, LauncherApp> = new Map();
	private customIcons: Map<number, Uint8Array> = new Map();
	private db: LauncherDatabase;

	private AUTOLOAD = true;

	constructor(props) {
		super(props);
		this.state = new AppState();

		
		if (typeof File === "undefined" || typeof Worker === "undefined") {
			this.setState({
				outdatedBrowser: true
			});
			return;
		}
		this.onWorkerError = this.onWorkerError.bind(this);
		this.onChangeInputFile = this.onChangeInputFile.bind(this);
		this.loadPrefs = this.loadPrefs.bind(this);
		this.loadAllApps = this.loadAllApps.bind(this);
		this.loadDatabase = this.loadDatabase.bind(this);
	}

	componentDidMount(): void {
		if (this.AUTOLOAD) {
			this.loadNetworkZipFile();
		}
	}

	getDefaultScreen(): number {
		const screens = this.state.screens;
		// Find a valid screen that has CONTAINER_NONE items
		const hasVisibleApps = (screenId: number) => {
			const screen = screens.get(screenId);
			return screen && screen.favorites.some(f => f.container === Favorite.CONTAINER_NONE);
		};

		if (typeof this.state.defaultScreen === "number" && hasVisibleApps(this.state.defaultScreen)) {
			return this.state.defaultScreen;
		}
		// Fall back to first screen with visible apps
		const firstVisible = Array.from(screens.values())
			.filter(s => s.screenRank > 0)
			.sort((a, b) => a.screenRank - b.screenRank)
			.find(s => s.favorites.some(f => f.container === Favorite.CONTAINER_NONE));
		return firstVisible ? firstVisible._id : 0;
	}

	onWorkerError(e: ErrorEvent) {
		console.error(e);
		if (e.message.indexOf("legacy browser") !== -1) {
			this.setState({
				outdatedBrowser: true
			});
		}
	}

	onChangeInputFile(e: ChangeEvent) {
		let target = e.target as HTMLInputElement;
		let file = target.files[0];
		this.setState({
			loadState: LoadState.LOADING
		});
		this.openZipFile(file);
	}

	loadNetworkZipFile() {
		this.setState({
			loadState: LoadState.LOADING
		});

		fetch("/sample/sample.novabackup")
			.then(response => response.arrayBuffer())
			.then(buffer => this.openZipFile(buffer));
	}

	openZipFile(file) {
		marky.mark('openZipFile');

        JSZip.loadAsync(file)
        .then(zip => {
			console.log(`Read zip file in ${marky.stop('openZipFile').duration.toFixed(1)} ms`);

			const pending: Promise<void>[] = [];
            zip.forEach((relativePath, zipEntry) => {
				if (zipEntry.name.endsWith(".db")) {
					pending.push(zipEntry.async("arraybuffer").then(this.loadDatabase));
				} else if (zipEntry.name.endsWith(".xml")) {
					pending.push(zipEntry.async("text").then(this.loadPrefs));
				}
            });
			return Promise.all(pending);
        })
        .then(() => {
        	this.setState({loadState: LoadState.LOADED});
		})
		.catch(error => {
			console.error(`Error loading backup file: ${error.message}`, error);
			this.setState({loadState: LoadState.NONE});
		});
	}

	loadPrefs(xml: string): void {
		this.prefs = XmlConverter.xml2js(xml, {compact: false}) as XmlConverter.Element;
		const prefs = {
			rows: this.findPref("desktop_grid_rows") as number,
			cols: this.findPref("desktop_grid_cols") as number,
			dockCols: this.findPref("dock_grid_cols") as number,
			defaultScreen: this.findPref("desktop_default_page") as number
		};
		if (!prefs.dockCols) {
			prefs.dockCols = 5; //Seems to be default
		}

		this.setState(prefs);
	}

	findPref(name: string): string | number | boolean {
		let map = this.prefs.elements[0];
		for (let element of map.elements) {
			if (element.attributes.name === name) {
				//Found element
				let value = typeof element.attributes.value !== "undefined"
					? element.attributes.value : element.elements[0].text;

				switch (element.name) {
					case "boolean": 
						return (value === "true");
					case "int":
					case "float":
						return parseFloat(value as string);
					default:
						return value;
				}
			}
		}
		console.warn(`findPref: Could not find setting ${name}`);
		return null;
	}

	loadDatabase(sqlFile: ArrayBuffer): Promise<void> {
		marky.mark('loadDatabase');
		return LauncherDatabase.create(sqlFile).then(db => {
			console.log(`Loaded SQLite database in ${marky.stop('loadDatabase').duration.toFixed(1)} ms`);
			this.db = db;
			this.loadAllApps();
		});
	}

	/**
	 * Called once after database initialization, as this will never change.
	 */
	loadAllApps() {
		marky.mark('loadAllApps');
		const results = this.db.getAllApps();
		console.log(`Loaded allapps in ${marky.stop('loadAllApps').duration.toFixed(1)} ms`);

		let apps: Map<string, LauncherApp> = new Map();
		for (let values of results.values) {
			let app = LauncherApp.fromArrays(results.columns, values);
			apps.set(app.packageName, app);
		}
		this.applist = apps;
		this.customIcons = this.db.getCustomIcons();
		console.log(`Loaded ${this.customIcons.size} custom icons`);
		this.loadFavorites();
	}

	getAppByPackageName(name: string): LauncherApp {
		return this.applist.get(name);
	}

	/** Parses a customIconSource URI and returns the icon blob, or null. */
	resolveCustomIconSource(source: string): Uint8Array | null {
		if (!source) return null;
		// URI format: icontheme_content_table://com.teslacoilsw.launcher.settings/customIcons/<id>
		const match = source.match(/\/customIcons\/(\d+)$/);
		if (!match) return null;
		return this.customIcons.get(parseInt(match[1])) ?? null;
	}

	/** Resolves the best available icon for a favorite, falling back through all sources. */
	resolveIcon(favorite: Favorite, app?: LauncherApp): Uint8Array | null {
		// 1. Blob directly on the favorite row
		if (favorite.icon != null) return favorite.icon;
		// 2. Custom icon source on the favorite
		const fromFav = this.resolveCustomIconSource(favorite.customIconSource);
		if (fromFav) return fromFav;
		// 3. Custom icon source on the matched allapps entry
		if (app) {
			const fromApp = this.resolveCustomIconSource(app.customIconSource);
			if (fromApp) return fromApp;
			// 4. Icon blob on the allapps entry (old format)
			if (app.icon != null) return app.icon;
		}
		return null;
	}

	loadFavorites() {
		marky.mark('loadFavorites');
		const results = this.db.getFavourites();
		console.log(`Loaded favorites in ${marky.stop('loadFavorites').duration.toFixed(1)} ms`);

		let screens: Map<number, Screen> = new Map();
		let favorites: Map<number, Favorite> = new Map();

		for (let values of results.values) {
			let favorite = Favorite.fromArrays(results.columns, values);
			let app;
			if (favorite.packageName) {
				app = this.getAppByPackageName(favorite.packageName);
			}

			//Add widget app name
			if (favorite.isWidget() && app) {
				favorite.widgetTitle = app.title;
			}

			//Add icon — resolve through all available sources
			const iconBlob = this.resolveIcon(favorite, app);
			if (iconBlob) {
				favorite.updateIcon(iconBlob);
			}

			//Add to screen
			if (!screens.get(favorite.screen)) {
				screens.set(favorite.screen, new Screen(favorite.screen, favorite.screenRank));
			}
			screens.get(favorite.screen).favorites.push(favorite);

			favorites.set(favorite._id, favorite);
		}

		//Add apps to folders
		favorites.forEach((favorite) => {
			if (favorite.container > 0) {
				favorites.get(favorite.container).folderContents.push(favorite);
			}
		});

		this.setState({
			favorites: favorites,
			screens: screens
		});
	}

	render() {
		if (this.state.outdatedBrowser) {
			return (
				<div className="alert alert-danger">
					One or more required features are not supported by your browser.
					<a href="http://outdatedbrowser.com/en" target="_blank" rel="noopener noreferrer" className="ml-2">
						Please update your browser.</a>
				</div>
			)
		}
	
		return (
		<div id="page-home">
			{/*<AppIcon/>*/}
			{(
				<div id="intro-box">
					<p>Welcome to the Nova Launcher editor. This web app allows you to view (and edit in the future!) exported Nova Launcher backup files, which have the extension
						<span className="badge badge-primary ml-2">.novabackup</span>
					</p>
					<p>The backup never leaves your device, it is inspected locally on your device using the HTML5 FileReader APIs. This means it will also work offline!</p>
					<FileForm onChange={this.onChangeInputFile} />
				</div>
			)}
			{(this.state.loadState === LoadState.LOADING) && (
				<div className="alert alert-primary">Opening backup file...</div>
			)}
			{(this.state.loadState === LoadState.LOADED && this.state.favorites.size > 0) &&
				<PagesView screens={this.state.screens} 
					rows={this.state.rows} 
					cols={this.state.cols}
					dockCols={this.state.dockCols}
					defaultScreen={this.getDefaultScreen()} />}
		</div>
		);
	}
}

export default App;
