import React, { Component, ChangeEvent, ChangeEventHandler } from 'react';
import JSZip from "jszip";
import { render } from 'react-dom';
import { QueryResults } from 'sql.js';
import XmlConverter from 'xml-js';
const marky = require('marky');

import Favorite, {FavoriteItemType} from "./classes/Favorite";
import FileForm from "./components/FileForm";
import PagesView from "./components/PagesView";
import LauncherApp from './classes/LauncherApp';
import Screen from './classes/Screen';
import { number } from 'prop-types';

class AppState {
	public outdatedBrowser = false;

	public zipFile: File;
	public screens: Map<number, Screen> = new Map();
	public favorites: Map<number, Favorite> = new Map();
	public rows = 0;
	public cols = 0;
	public dockCols = 0;
	public defaultScreen = 0;
}

class App extends Component<{}, AppState> {
	private worker: Worker;
	private prefs: XmlConverter.Element;
	private applist: Map<string, LauncherApp> = new Map();

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

		this.worker = new Worker(process.env.PUBLIC_URL + "/worker.sql.js");
		this.worker.onerror = this.onWorkerError;
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
			zipFile: file
		});
		this.openZipFile(file);
	}

	openZipFile(file: File) {
		marky.mark('openZipFile')

        JSZip.loadAsync(file)
        .then(zip => {
			console.log(`Read zip file in ${marky.stop('openZipFile').duration.toFixed(1)} ms`);

            zip.forEach((relativePath, zipEntry) => {
				if (zipEntry.name == "launcher.db") {
					zipEntry.async("arraybuffer").then(this.loadDatabase);
				} else if (zipEntry.name.endsWith("launcher_preferences.xml")) {
					zipEntry.async("text").then(this.loadPrefs);
				}
            });
        }, error => {
			console.error(`Error reading ${file.name}: ${error.message}`);
        });
	}

	loadPrefs(xml: string) {
		this.prefs = XmlConverter.xml2js(xml, {compact: false}) as XmlConverter.Element;
		this.setState({
			rows: this.findPref("desktop_grid_rows") as number,
			cols: this.findPref("desktop_grid_cols") as number,
			dockCols: this.findPref("dock_grid_cols") as number,
			defaultScreen: this.findPref("desktop_default_page") as number
		});
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
						return (value == "true");
					case "int":
					case "float":
						return parseFloat(value as string);
					default:
						return value;
				}
			}
		}
		console.warn(`Could not find setting ${name}`);
		return null;
	}

	loadDatabase(sqlFile: ArrayBuffer) {
		marky.mark('loadDatabase');
		this.worker.onmessage = () => {
			console.log(`Loaded SQLite database in ${marky.stop('loadDatabase').duration.toFixed(1)} ms`);
			this.loadAllApps();
		};
		this.worker.postMessage({action: 'open', buffer: sqlFile}, [sqlFile]);
	}

	/**
	 * Called once after database initialization, as this will never change.
	 */
	loadAllApps() {
		marky.mark('loadAllApps');
		this.worker.onmessage = (event: MessageEvent) => {
			console.log(`Loaded allapps in ${marky.stop('loadAllApps').duration.toFixed(1)} ms`);
			let results: QueryResults = event.data.results[0];

			let apps: Map<string, LauncherApp> = new Map();
			for (let values of results.values) {
				let app = LauncherApp.fromArrays(results.columns, values);
				apps.set(app.packageName, app);
			}
			this.applist = apps;
			console.log(this.applist);	
			this.loadFavorites();
		}
		this.worker.postMessage({
			action: 'exec', 
			sql: `SELECT _id, componentName, title, icon FROM allapps`
		});
	}

	getAppByPackageName(name: string): LauncherApp {
		return this.applist.get(name);
	}

	loadFavorites() {
		marky.mark('loadFavorites');
		this.worker.onmessage = (event: MessageEvent) => {
			console.log(`Loaded favorites in ${marky.stop('loadFavorites').duration.toFixed(1)} ms`);
			let results: QueryResults = event.data.results[0];
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

				//Add icon
				if (favorite.icon == null) {
					if (app) {
						favorite.updateIcon(app.icon);
					}
				} else {
					favorite.updateIcon();
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
		this.worker.postMessage({
			action: 'exec', 
			sql: `SELECT favorites.*,
					IFNULL(workspaceScreens.screenRank, -1) AS screenRank
				FROM favorites
				LEFT JOIN workspaceScreens
					ON favorites.screen = workspaceScreens._id`
		});
	}

	render() {
		if (this.state.outdatedBrowser) {
			return (
				<div className="alert alert-danger">
					One or more required features are not supported by your browser.
					<a href="http://outdatedbrowser.com/en" target="_blank" className="ml-2">
						Please update your browser.</a>
				</div>
			)
		}
	
		return (
		<div>
			{!this.state.zipFile && (
				<div>
					<p>Welcome to the Nova Launcher editor. This web app allows you to edit exported Nova Launcher backup files, which have the extension 
						<span className="badge badge-primary ml-2">.novabackup</span>
					</p>
					<p>Once selecting your file, you will be able to edit the placement of apps on the homescreen. The file is not uploaded, it is edited locally on your device using the HTML5 File APIs. This means it will also work offline!</p>
					<FileForm onChange={this.onChangeInputFile} />
				</div>
			)}
			{(this.state.zipFile && this.state.favorites.size === 0) && (
				<div className="alert alert-primary">Opening backup file...</div>
			)}
			{this.state.favorites.size > 0 &&
				<PagesView screens={this.state.screens} 
					rows={this.state.rows} 
					cols={this.state.cols}
					dockCols={this.state.dockCols}
					defaultScreen={this.state.defaultScreen} />}
		</div>
		);
	}
}

export default App;
