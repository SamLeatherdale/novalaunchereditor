export default class LauncherApp {
    /** Primary key assigned by the database. */
	_id: number;
	/** Combination of the app's package name and main activity name. */
    componentName: string;
    /** App's title. 
     * This is sometimes NULL, so the Favorite name should be used instead. */
    title: string;
    icon: Uint8Array;

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