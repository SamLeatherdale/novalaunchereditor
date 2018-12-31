import { QueryResults } from 'sql.js';
import { type } from 'os';

export enum FavoriteItemType {
	App = 0,
	LauncherAction = 1,
	Folder = 2,
	Widget = 4,
	Link = 6
}

export enum FavoriteFlags {
	Action = 2,
	Link = 3
}

export interface Intent {
	action: string;
	category: string;
	launchFlags: string;
	component: string;
	profile: string;
}

export default class Favorite {
	public static readonly CONTAINER_NONE = -100;
	public static readonly CONTAINER_HOTSEAT = -101;

	/** Primary key assigned by the database. */
	_id: number;
	/** Label that appears below the app on the homescreen. */
	title: string;
	/** The intent launched when the user clicks this app. */
	intent: string;
	/** The folder that this app is in.
	 * -100 means no container.
	 * -101 means in hotseat.
	 */
	container: number;
	/** Which homescreen page the app appears on.
	 * 0 means this app is in a folder.
	 */
	screen: number;
	/** The order of the screens.
	 * -1 means this app is not on a visible screen.
	 */
	screenRank: number;
	/** Which hotseat position the app occupies. */
	hotseatRank: number;
	/** Which column the app appears in. */
	cellX: number;
	/** Which row the app appears in. */
	cellY: number;
	/** How wide the widget appears. */
	spanX: number;
	/** How tall the widget appears. */
	spanY: number;
	/** The app stacking order. */
	zOrder: number;
	/** Number determining the type of item (app, folder, widget, etc). */
	itemType: FavoriteItemType;
	appWidgetId: number;

	/** The icon data as returned from the database.  */
	icon: Uint8Array;
	/** A combination of a package name and activity name representing the activity that
	 * this widget shows.
	 */
	appWidgetProvider: string;
	flags: FavoriteFlags;
	modified: number;

	//Custom properties
	
	/** The generated base64 icon url. */
	iconurl: string;

	parsedIntent: Intent;
	packageName: string = "";
	activityName: string = "";
	widgetTitle: string = "";

	folderContents: Favorite[] = [];

	static fromArrays(columns: string[], values: any[]) : Favorite {
		let favorite = new Favorite();
		for (let i = 0; i < columns.length; i++) {
			favorite[columns[i]] = values[i];
		}

		if (favorite.intent != null) {
			favorite.parsedIntent = Favorite.parseIntent(favorite.intent);
			let component = favorite.parsedIntent.component.split("/");
			favorite.packageName = component[0];
			favorite.activityName = component[1];
		} else if (favorite.appWidgetProvider != null) {
			let component = favorite.appWidgetProvider.split("/");
			favorite.packageName = component[0];
			favorite.activityName = component[1];
		}

		return favorite;
	}

	static parseIntent(intent: string): Intent {
		if (intent == null) {
			return {} as Intent;
		}

		const props = intent.split(";");
		const result = {} as Intent;

		for (let prop of props) {
			let parts = prop.split("=");
			let key = parts[0];
			let value = parts.length > 0 ? parts[1] : "";
			result[key] = value;
		}
		return result;
	}

	/** Convert image to object URL
	 * @param iconblob The raw icon blob data from the database.
	 */
	updateIcon(iconblob?: Uint8Array) {
		if (typeof iconblob === "undefined") {
			iconblob = this.icon;
		}
		let blob = new Blob([iconblob], {'type': 'image/png'});
		this.iconurl = URL.createObjectURL(blob);
	}

	isWidget() {
		return this.itemType === FavoriteItemType.Widget;
	}

	isFolder() {
		return this.itemType === FavoriteItemType.Folder;
	}
}
