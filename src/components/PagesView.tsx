import React, {Component, MouseEvent, MouseEventHandler, CSSProperties} from "react";
import Favorite from "../classes/Favorite";
import Screen from "../classes/Screen"
import DockArrow from "./DockArrow";

class PagesViewState {
    public screen = 0;
    public screens: number[] = [];
}

interface PagesViewProps {
    screens: Map<number, Screen>;
    rows: number;
    cols: number;
    dockCols: number;
    defaultScreen: number;
}

class PagesView extends Component<PagesViewProps, PagesViewState> {
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
        const screenApps: Favorite[] = this.props.screens.get(this.state.screen)
            .favorites.filter(favorite => {
            return (favorite.container === Favorite.CONTAINER_NONE);
        });
        const hotseatApps: Favorite[] = this.props.screens.get(0)
            .favorites.filter(favorite => {
            return (favorite.container === Favorite.CONTAINER_HOTSEAT);
        });

        const desktopContainerStyle = {
            backgroundImage: `url(${process.env.PUBLIC_URL}/phone_wallpaper.jpg)`
        };

        return (
        <div className="pages-view">
            <div className="desktop-container" style={desktopContainerStyle}>
                <div className="desktop-container-overlay">
                    <AppGrid apps={screenApps} rows={this.props.rows} cols={this.props.cols} drawer={false} />
                    <DockArrow />
                    <AppGrid apps={hotseatApps} rows={1} cols={this.props.dockCols} drawer={true} />
                </div>
            </div>
            <NavBar screens={this.props.screens} screen={this.state.screen} 
                onClickButton={this.onClickScreenButton} />
        </div>
        );
    }
}

class AppGrid extends Component<{
    rows: number,
    cols: number,
    apps: Favorite[],
    drawer: boolean
}, {}> {
    public static readonly GRID_ITEM_HEIGHT = 75;
    public static readonly GRID_ITEM_WIDTH = 75;

    render() {
        //Fill grid with apps
        const gridApps: Favorite[][] = [];
        for (let y = 0; y < this.props.rows; y++) {
            gridApps[y] = new Array(this.props.cols);
        }

        for (let app of this.props.apps) {
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

        const classes = ["desktop-grid"];
        if (this.props.drawer) {
            classes.push("drawer-grid");
        }
        const gridStyle = {
            gridTemplateRows: `repeat(${this.props.rows}, ${AppGrid.GRID_ITEM_HEIGHT}px)`,
            gridTemplateColumns: `repeat(${this.props.cols}, ${AppGrid.GRID_ITEM_WIDTH}px)`
        };
                
        return (
        <div className={classes.join(" ")} style={gridStyle}>
            {gridItems}
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
        const iconStyle = app.iconurl && !app.isFolder() ? {backgroundImage: `url(${app.iconurl})`} : {};
        const title = app.isWidget() 
            ? (app.widgetTitle ? app.widgetTitle : app.packageName) 
            : app.title;

        if (app.isWidget()) {
            classes.push("grid-widget");
        }

        let folder = [];
        let folderContainerStyles: CSSProperties = {};
        if (app.isFolder()) {
            //Get folder width
            const width = app.folderContents.reduce((width, favorite) => {
                return favorite.cellX > width ? favorite.cellX : width;
            }, 0);

            classes.push("grid-folder");
            folder = app.folderContents.sort((a, b) => {
                let c = a.cellY * width + a.cellX;
                let d = b.cellY * width + b.cellX;
                return (c === d) ? 0 : (c > d ? 1 : -1);
            }).map(favorite => {
                return <GridApp app={favorite} key={favorite._id} />
            });
        }

        return (
            <div className={classes.join(" ")} 
                style={gridItemStyle}
                title={title}>
                <div className="grid-app-icon" style={iconStyle}>{
                    app.isFolder() && 
                        <div className="grid-folder-container"
                            style={folderContainerStyles}>{folder}</div>
                }</div>
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
        const screens = Array.from(this.props.screens.values()).filter(screen => {
            return (screen.screenRank > -1);
        });
        const navBar = [];

        screens.sort((a, b) => {
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