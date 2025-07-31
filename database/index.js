'use strict';

const { Sequelize } = require('sequelize');
const config = require('../config');
const createLogger = require('../logger');
const logger = createLogger();
const fs = require('fs');
const path = require('path');

const db = {};

const sequelizeConfig = {
    dialect: config.database.dialect,
    storage: config.database.dialect === 'sqlite' ? config.database.storage : undefined,
    logging: (msg) => logger.debug(msg),
};

if (config.database.dialect === 'mysql') {
    sequelizeConfig.host = config.database.host;
    sequelizeConfig.port = config.database.port;
    sequelizeConfig.username = config.database.username;
    sequelizeConfig.password = config.database.password;
    sequelizeConfig.database = config.database.database;
}

const sequelize = new Sequelize(sequelizeConfig);

const modelsDir = path.join(__dirname, 'models');
fs.readdirSync(modelsDir)
  .filter(file => {
    return (file.indexOf('.') !== 0) && (file.slice(-3) === '.js');
  })
  .forEach(file => {
    const model = require(path.join(modelsDir, file))(sequelize, Sequelize.DataTypes);
    db[model.name] = model;
  });

Object.keys(db).forEach(modelName => {
  if (db[modelName].associate) {
    db[modelName].associate(db);
  }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
