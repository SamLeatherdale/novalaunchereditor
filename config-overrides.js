const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = function override(config, env) {
    if (!config.plugins) {
        config.plugins = [];
    }

    const sqlJsPath = "node_modules/sql.js/dist";
    config.plugins.push(
        (process.env.NODE_ENV === 'production')
            ? new CopyWebpackPlugin([{from: sqlJsPath}])
            : new CopyWebpackPlugin([{from: sqlJsPath, to: 'dist'}])
    );

    return config;
};