const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { parse } = require("yaml");

const config = parse(readFileSync(join(__dirname, "electron-builder.yml"), "utf8"));
config.appId = "sh.omp.gui.personal";
// This side-by-side install must not claim omp:// or use the official update channel.
delete config.protocols;
config.publish = null;
module.exports = config;
