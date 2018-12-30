import { QueryResults } from 'sql.js';

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

export default class Favorite {
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
	itemType: FavoriteItemType;
	appWidgetId: number;

	/** The icon data as returned from the database.  */
	iconblob: Uint8Array;
	iconurl: string;

	flags: FavoriteFlags;

	modified: number;

	static fromArrays(columns: string[], values: any[]) : Favorite {
		let favorite = new Favorite();
		for (let i = 0; i < columns.length; i++) {
			favorite[columns[i]] = values[i];
		}

		//Convert image to object URL
		let blob = new Blob([favorite.iconblob], {'type': 'image/png'});
		favorite.iconurl = URL.createObjectURL(blob);

		return favorite;
	}
}
