import Favorite from "./Favorite";

class Screen {
    /** ID assigned by the database. 
     * Also the foreign key in the favorites table.  */
    _id: number;
    /** The sort order of the screens.
	 */
    screenRank: number;

    /** Custom properties */
    favorites: Favorite[] = [];

    constructor(_id: number, screenRank: number) {
        this._id = _id;
        this.screenRank = screenRank;
    }
}

export default Screen;