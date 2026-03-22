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

    /** Returns true if the given table exists in the database. */
    private hasTable(name: string): boolean {
        const res = this.db.exec(
            `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, [name]
        );
        return res.length > 0 && res[0].values.length > 0;
    }

    /** Returns true if the given column exists on the given table. */
    private hasColumn(table: string, column: string): boolean {
        const res = this.db.exec(`PRAGMA table_info(${table})`);
        if (!res[0]) return false;
        return res[0].values.some(row => row[1] === column);
    }

    getAllApps(): QueryExecResult {
        const hasCustomIconSource = this.hasColumn('allapps', 'customIconSource');
        const hasIconBlob = this.hasColumn('allapps', 'icon');

        const cols = [
            '_id', 'componentName', 'title',
            hasCustomIconSource ? 'customIconSource' : 'NULL as customIconSource',
            hasIconBlob ? 'icon' : 'NULL as icon',
        ].join(', ');

        const res = this.db.exec(`SELECT ${cols} FROM allapps`);
        return res[0];
    }

    getFavourites(): QueryExecResult {
        const hasScreenRankCol = this.hasColumn('favorites', 'rank');
        const hasWorkspaceScreens = this.hasTable('workspaceScreens');

        let screenRankExpr: string;
        if (hasScreenRankCol) {
            screenRankExpr = 'screen AS screenRank';
        } else if (hasWorkspaceScreens) {
            screenRankExpr = 'IFNULL(workspaceScreens.screenRank, -1) AS screenRank';
        } else {
            screenRankExpr = 'screen AS screenRank';
        }

        const joinClause = (!hasScreenRankCol && hasWorkspaceScreens)
            ? 'LEFT JOIN workspaceScreens ON favorites.screen = workspaceScreens._id'
            : '';

        const res = this.db.exec(
            `SELECT favorites.*, ${screenRankExpr} FROM favorites ${joinClause}`
        );
        return res[0];
    }

    /** Returns a map of customIcon _id -> PNG blob for all custom icons in the DB. */
    getCustomIcons(): Map<number, Uint8Array> {
        const result = new Map<number, Uint8Array>();
        if (!this.hasTable('customIcons')) return result;

        const res = this.db.exec(`SELECT _id, icon FROM customIcons WHERE icon IS NOT NULL`);
        if (!res[0]) return result;

        for (const row of res[0].values) {
            const id = row[0] as number;
            const blob = row[1] as Uint8Array;
            result.set(id, blob);
        }
        return result;
    }
}
