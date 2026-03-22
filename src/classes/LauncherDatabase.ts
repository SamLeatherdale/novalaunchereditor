import type initSqlJs from "sql.js";

type Database = initSqlJs.Database;
type InitSqlJsStatic = initSqlJs.InitSqlJsStatic;
type QueryExecResult = initSqlJs.QueryExecResult;
type SqlJsStatic = initSqlJs.SqlJsStatic;

export default class LauncherDatabase {
    static initialized = false;
    static SQL: SqlJsStatic;

    private db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    static create(array: ArrayBuffer): Promise<LauncherDatabase> {
        const uint = new Uint8Array(array);
        const createDb = () => {
            return new LauncherDatabase(new LauncherDatabase.SQL.Database(uint));
        };

        if (!LauncherDatabase.initialized) {
            //We have to use the compiled page-loaded version, but we can keep typing info
            const initSqlJs: InitSqlJsStatic = (window as any).initSqlJs;

            return initSqlJs({
                locateFile: filename => (import.meta.env.BASE_URL + "dist/sqljs/" + filename)
            }).then(SQL => {
                LauncherDatabase.initialized = true;
                LauncherDatabase.SQL = SQL;
                return createDb();
            });
        }
        return Promise.resolve(createDb());
    }

    getMetadata() {
        const res = this.db.exec("SELECT * FROM sqlite_master");
        console.log(res);
        return res[0];
    }

    getAllApps(): QueryExecResult {
        const res = this.db.exec(`SELECT _id, componentName, title, icon FROM allapps`);
        return res[0];
    }

    getFavourites(): QueryExecResult {
        const res = this.db.exec(
            `SELECT favorites.*,
					IFNULL(workspaceScreens.screenRank, -1) AS screenRank
				FROM favorites
				LEFT JOIN workspaceScreens
					ON favorites.screen = workspaceScreens._id`);
        return res[0];
    }
}
