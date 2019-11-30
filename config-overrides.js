const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = function override(config, env) {
    if (!config.plugins) {
        config.plugins = [];
    }

    const sqlJsPath = "node_modules/sql.js/dist";
    config.plugins.push(new CopyWebpackPlugin([{from: sqlJsPath, to: 'dist/sqljs'}])
    );

    return config;
};