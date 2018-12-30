import React, {Component} from "react";
import Favorite from "../classes/Favorite";

class PagesViewState {
    public screen = 0;

    constructor(screen) {
        this.screen = screen;
    }
}

interface PagesViewProps {
    favorites: Favorite[];
    rows: number;
    cols: number;
    defaultScreen: number;
}

class PagesView extends Component<PagesViewProps, PagesViewState> {
    private GRID_ITEM_SIZE = 75;

    constructor(props) {
        super(props);
        this.state = new PagesViewState(this.props.defaultScreen);
    }

    render() {
        const apps = this.props.favorites.filter((favorite) => {
            return (favorite.screen == this.state.screen 
                && favorite.container < 0
                && favorite.hotseatRank < 0);
        });
        console.log(apps);

        //Fill grid with apps
        let gridApps: Favorite[][] = [];
        for (let y = 0; y < this.props.rows; y++) {
            gridApps[y] = new Array(this.props.cols);
        }

        for (let app of apps) {
            for (let x = app.cellX; x < app.spanX + app.cellX; x++) {
                for (let y = app.cellY; y < app.spanY + app.cellY; y++) {
                    let current;
                    try {
                        current = gridApps[y][x];
                    } catch (e) {
                        console.error(`Out of bounds [${x}, ${y}]: app ${app.title}`);
                    }
                    if (current) {
                        console.warn(`Collision in grid at [${x}, ${y}]: apps ${current.title} and ${app.title}`);
                    } else {
                        gridApps[y][x] = app;
                    }
                }
            }
        }
        console.log(gridApps);

        //Convert grid to list of grid items
        const gridItems = [];
        for (let y = 0; y < gridApps.length; y++) {
            let row = gridApps[y];
            for (let x = 0; x < row.length; x++) {
                let app = row[x];

                if (!app) {
                    gridItems.push(
                        <div className="grid-app"></div>
                    );
                    continue;
                } else if (x === app.cellX && y === app.cellY) {
                    let gridItemStyle = {
                        gridColumnStart: `span ${app.spanX}`,
                        gridRowStart: `span ${app.spanY}`
                    };
                    let iconStyle = app.iconurl ? {backgroundImage: `url(${app.iconurl})`} : {};

                    gridItems.push(
                        <div key={app._id} className="grid-app" style={gridItemStyle}>
                            <div className="grid-app-icon" style={iconStyle}></div>
                            <div className="grid-app-title">{app.title}</div>
                        </div>
                    )
                }
            }
        }

        const gridStyle = {
            gridTemplateRows: `repeat(${this.props.rows}, ${this.GRID_ITEM_SIZE}px)`,
            gridTemplateColumns: `repeat(${this.props.cols}, ${this.GRID_ITEM_SIZE}px)`
        };
    return (
        <div className="desktop-grid" style={gridStyle}>
            {gridItems}
        </div>
    );
    }
}

export default PagesView;