export default class LauncherApp {
    /** Primary key assigned by the database. */
	_id: number;
	/** Combination of the app's package name and main activity name. */
    componentName: string;
    /** App's title. 
     * This is sometimes NULL, so the Favorite name should be used instead. */
    title: string;
    /** Icon blob (old format only). */
    icon: Uint8Array;
    /** Custom icon source URI, e.g. icontheme_content_table://...customIcons/4 (new format). */
    customIconSource: string;

    packageName: string;
    activityName: string;
    
    static fromArrays(columns: string[], values: any[]) : LauncherApp {
		let app = new LauncherApp();
		for (let i = 0; i < columns.length; i++) {
			app[columns[i]] = values[i];
        }
        
        let parts = app.componentName.split("/");
        app.packageName = parts[0];
        app.activityName = parts[1];

		return app;
	}
}