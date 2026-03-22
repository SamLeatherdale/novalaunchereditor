import React, {Component, MouseEvent, MouseEventHandler, CSSProperties} from "react";
import Favorite, { FavoriteItemType } from "../classes/Favorite";
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
        const allFavorites: Favorite[] = Array.from(this.props.screens.values())
            .flatMap(s => s.favorites);
        // Deduplicate hotseat by cell position — old format could have multiple dock
        // pages creating duplicate items at the same cellX
        const hotseatSeen = new Set<number>();
        const hotseatApps: Favorite[] = allFavorites
            .filter(f => f.container === Favorite.CONTAINER_HOTSEAT)
            .filter(f => {
                const key = Math.round(f.cellX);
                if (hotseatSeen.has(key)) return false;
                hotseatSeen.add(key);
                return true;
            })
            .sort((a, b) => a.cellX - b.cellX);

        const desktopContainerStyle = {
            backgroundImage: `url(/phone_wallpaper.jpg)`
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
    public static readonly CELL_SIZE_PX = 75;

    render() {
        const { rows, cols, apps, drawer } = this.props;
        const cellW = AppGrid.CELL_SIZE_PX;
        const cellH = AppGrid.CELL_SIZE_PX;
        const totalW = cols * cellW;
        const totalH = rows * cellH;

        const items = apps.map(app => (
            <GridApp
                key={app._id}
                app={app}
                cellW={cellW}
                cellH={cellH}
            />
        ));

        const classes = ["desktop-grid", drawer ? "drawer-grid" : ""].filter(Boolean);

        return (
            <div
                className={classes.join(" ")}
                style={{ width: totalW, height: totalH, position: "relative" }}
            >
                {items}
            </div>
        );
    }
}

class GridApp extends Component<{
    app: Favorite,
    cellW?: number,
    cellH?: number,
}, {}> {
    render() {
        const app = this.props.app;
        const cellW = this.props.cellW ?? AppGrid.CELL_SIZE_PX;
        const cellH = this.props.cellH ?? AppGrid.CELL_SIZE_PX;
        const classes = ["grid-app"];
        const gridItemStyle: CSSProperties = {
            position: "absolute",
            left: app.cellX * cellW,
            top: app.cellY * cellH,
            width: app.spanX * cellW,
            height: app.spanY * cellH,
        };
        const iconStyle = app.iconurl && !app.isFolder() ? {backgroundImage: `url(${app.iconurl})`} : {};
        const isLauncherAction = app.itemType === FavoriteItemType.LauncherAction;
        const title = app.isWidget()
            ? (app.widgetTitle ? app.widgetTitle : app.packageName)
            : isLauncherAction ? null
            : app.title;

        if (app.isWidget()) {
            classes.push("grid-widget");
        }

        let folder = [];
        let folderContainerStyles: CSSProperties = {};
        if (app.isFolder()) {
            classes.push("grid-folder");
            folder = app.folderContents.sort((a, b) => {
                const c = a.cellY * 4 + a.cellX;
                const d = b.cellY * 4 + b.cellX;
                return c === d ? 0 : c > d ? 1 : -1;
            }).map(favorite => {
                const itemIconStyle = favorite.iconurl
                    ? { backgroundImage: `url(${favorite.iconurl})` }
                    : {};
                return (
                    <div className="grid-folder-item" key={favorite._id}
                        style={itemIconStyle} title={favorite.title} />
                );
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
            return screen.screenRank > 0 &&
                screen.favorites.some(f => f.container === Favorite.CONTAINER_NONE);
        });
        const navBar = [];

        screens.sort((a, b) => {
            return a.screenRank === b.screenRank ? 0 : (a.screenRank > b.screenRank ? 1 : -1)
        }).forEach((screen, index) => {
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
                    onClick={this.props.onClickButton}>{index + 1}</div>
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