import React, { Component, ChangeEvent, ChangeEventHandler } from 'react';
import JSZip from "jszip";
import { render } from 'react-dom';
import { QueryResults } from 'sql.js';
import XmlConverter from 'xml-js';

import Favorite, {FavoriteItemType} from "./classes/Favorite";
import FileForm from "./components/FileForm";
import PagesView from "./components/PagesView";
import LauncherApp from './classes/LauncherApp';

class AppState {
	public zipFile: File
	public favorites: Favorite[] = [];
	public rows = 0;
	public cols = 0;
	public defaultScreen = 0;
}

interface AppList {
	[prop: string]: LauncherApp;
}

class App extends Component<{}, AppState> {
	private worker: Worker;
	private prefs: XmlConverter.Element;
	private applist: AppList = {};

	constructor(props) {
		super(props);
		this.state = new AppState();

		this.onWorkerError = this.onWorkerError.bind(this);
		this.onChangeInputFile = this.onChangeInputFile.bind(this);
		this.loadPrefs = this.loadPrefs.bind(this);
		this.loadAllApps = this.loadAllApps.bind(this);
		this.loadDatabase = this.loadDatabase.bind(this);

		this.worker = new Worker(process.env.PUBLIC_URL + "/worker.sql.js");
		this.worker.onerror = this.onWorkerError;
	}

	onWorkerError(e) {
		console.error(e);
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
		console.log("Reading zip file");
		const dateStart = new Date();

        JSZip.loadAsync(file)
        .then(zip => {
			const dateEnd = new Date();
			console.log(`Read zip file in ${dateEnd.getTime() - dateStart.getTime()} ms`);

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
		let startDate = new Date();
		this.worker.onmessage = () => {
			let endDate = new Date();
			console.log(`Loaded SQLite database in ${endDate.getTime() - startDate.getTime()} ms`);
			this.loadAllApps();
		};
		this.worker.postMessage({action: 'open', buffer: sqlFile}, [sqlFile]);
	}

	/**
	 * Called once after database initialization, as this will never change.
	 */
	loadAllApps() {
		this.worker.onmessage = (event: MessageEvent) => {
			let results: QueryResults = event.data.results[0];

			let apps = {};
			for (let values of results.values) {
				let app = LauncherApp.fromArrays(results.columns, values);
				apps[app.packageName] = app;
			}
			this.applist = apps;
			console.log(this.applist);	
			this.loadFavorites();
		}
		this.worker.postMessage({
			action: 'exec', 
			sql: `SELECT * FROM allapps`
		});
	}

	getAppByPackageName(name: string): LauncherApp {
		return this.applist[name];
	}

	loadFavorites() {
		this.worker.onmessage = (event: MessageEvent) => {
			let results: QueryResults = event.data.results[0];
			
			let favorites: Favorite[] = results.values.map((values) => {
				let favorite = Favorite.fromArrays(results.columns, values);
				if (favorite.icon == null) {
					let app = this.getAppByPackageName(favorite.packageName);
					if (app) {
						favorite.updateIcon(app.icon);
					}
				} else {
					favorite.updateIcon();
				}
				return favorite;
			});
			this.setState({
				favorites: favorites
			});
		}
		this.worker.postMessage({
			action: 'exec', 
			sql: `SELECT favorites.*,
					IFNULL(workspaceScreens.screenRank, -1) AS screenRank
				FROM favorites
				JOIN workspaceScreens
					ON favorites.screen = workspaceScreens._id`
		});
	}

	render() {
		if (typeof File === "undefined") {
			return <h1>HTML5 FileReader API not supported.</h1>;
		}
		if (typeof Worker === "undefined") {
			return <h1>WebWorker API is not supported.</h1>;
		}
	
		return (
		<div className="container">
			{!this.state.zipFile && <FileForm onChange={this.onChangeInputFile} />}
			{this.state.favorites.length > 0 &&
				<PagesView favorites={this.state.favorites} 
					rows={this.state.rows} 
					cols={this.state.cols}
					defaultScreen={this.state.defaultScreen} />}
		</div>
		);
	}
}

export default App;
