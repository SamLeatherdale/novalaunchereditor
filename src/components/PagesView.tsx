import React, {Component, MouseEvent, MouseEventHandler} from "react";
import Favorite from "../classes/Favorite";
import Screen from "../classes/Screen"
class PagesViewState {
    public screen = 0;
    public screens: number[] = [];

    constructor() {
    }
}

interface PagesViewProps {
    screens: Map<number, Screen>;
    rows: number;
    cols: number;
    defaultScreen: number;
}

class PagesView extends Component<PagesViewProps, PagesViewState> {
    public readonly GRID_ITEM_HEIGHT = 75;
    public readonly GRID_ITEM_WIDTH = 75;

    constructor(props) {
        super(props);

        let state = new PagesViewState();
        state.screen = props.defaultScreen;

        this.state = state;

        this.onClickScreenButton = this.onClickScreenButton.bind(this);
    }

    onClickScreenButton(e: MouseEvent) {
        let target = e.target as HTMLElement;
        this.setState({
            screen: parseInt(target.dataset["value"])
        });
    }

    render() {
        const apps: Favorite[] = this.props.screens.get(this.state.screen).favorites.filter((favorite) => {
            return (favorite.container === Favorite.CONTAINER_NONE
                //&& favorite.hotseatRank < 0
            );
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
        let emptyItemCount = 0;

        for (let y = 0; y < gridApps.length; y++) {
            let row = gridApps[y];
            for (let x = 0; x < row.length; x++) {
                const app = row[x];

                
                if (!app) {
                    gridItems.push(
                        <div className="grid-app" key={emptyItemCount++}></div>
                    );
                    continue;
                } else if (!(x === app.cellX && y === app.cellY)) {
                    continue;
                }

                
                gridItems.push(<GridApp app={app} key={app._id} />);
            }
        }

        const gridStyle = {
            gridTemplateRows: `repeat(${this.props.rows}, ${this.GRID_ITEM_HEIGHT}px)`,
            gridTemplateColumns: `repeat(${this.props.cols}, ${this.GRID_ITEM_WIDTH}px)`
        };

        const desktopContainerStyle = {
            backgroundImage: `url(${process.env.PUBLIC_URL}/phone_wallpaper.jpg)`
        }

    return (
        <div className="pages-view">
            <div className="desktop-container" style={desktopContainerStyle}>
                <div className="desktop-grid" style={gridStyle}>
                    {gridItems}
                </div>
            </div>
            <NavBar screens={this.props.screens} screen={this.state.screen} 
                onClickButton={this.onClickScreenButton} />
        </div>
    );
    }
}

class GridApp extends Component<{
    app: Favorite
}, {}> {
    render() {
        const app = this.props.app;
        const classes = ["grid-app"];
        const gridItemStyle = {
            gridColumnStart: `span ${app.spanX}`,
            gridRowStart: `span ${app.spanY}`
        };
        const iconStyle = app.iconurl ? {backgroundImage: `url(${app.iconurl})`} : {};
        const title = app.isWidget() 
            ? (app.widgetTitle ? app.widgetTitle : app.packageName) 
            : app.title;

        if (app.isWidget()) {
            classes.push("grid-widget");
        }

        return (
            <div className={classes.join(" ")} 
                style={gridItemStyle}
                title={title}>
                <div className="grid-app-icon" style={iconStyle}></div>
                <div className="grid-app-title">{title}</div>
            </div>
        );
    }
}

class NavBar extends Component<{
    screens: Map<number, Screen>,
    screen: number
    onClickButton: MouseEventHandler
}, {}> {
    render() {
        const navBar = [];

        Array.from(this.props.screens.values()).sort((a, b) => {
            return a.screenRank === b.screenRank ? 0 : (a.screenRank > b.screenRank ? 1 : -1)
        }).forEach((screen) => {
            let classes = ["btn"];
            if (screen._id === this.props.screen) {
                classes.push("btn-primary active");
            } else {
                classes.push("btn-outline-primary")
            }

            navBar.push(
                <div className={classes.join(" ")} 
                    key={screen._id} 
                    data-value={screen._id}
                    onClick={this.props.onClickButton}>{screen.screenRank + 1}</div>
            );
        });

        return (
            <div className="btn-group btn-group-toggle">
            {navBar}
            </div>
        );
    }
}

export default PagesView;