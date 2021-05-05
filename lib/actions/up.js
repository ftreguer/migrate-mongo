const _ = require("lodash");
const pEachSeries = require("p-each-series");
const { promisify } = require("util");
const fnArgs = require('fn-args');

const status = require("./status");
const config = require("../env/config");
const migrationsDir = require("../env/migrationsDir");
const hasCallback = require('../utils/has-callback');

const getItemsToMigrate = async db => {
  const shouldMigrateNextOnly = _.get(global.options, "next");
  const targetedFileName = _.get(global.options, "target");

  if (shouldMigrateNextOnly && targetedFileName) {
    throw new Error("Options -n (--next) and -t (--target) are incompatible. You must choose either one OR the other.");
  }
  
  const statusItems = await status(db);

  const pendingItems = _.filter(statusItems, { appliedAt: "PENDING" });

  if (targetedFileName && !_.find(pendingItems, { fileName: targetedFileName })) {
    throw new Error(`File ${targetedFileName} is not part of the pending migrations`);
  }

  if (targetedFileName) {
    return _.takeWhile(pendingItems, ({ fileName }) => fileName <= targetedFileName);
  }

  if (shouldMigrateNextOnly) {
    return [_.first(pendingItems)];
  }

  return pendingItems;
}

module.exports = async (db, client) => {
  const itemsToMigrate = await getItemsToMigrate(db);
  const migrated = [];
  const migrationBlock = Date.now();

  const migrateItem = async item => {
    try {
      const migration = await migrationsDir.loadMigration(item.fileName);
      const up = hasCallback(migration.up) ? promisify(migration.up) : migration.up;

      if (hasCallback(migration.up) && fnArgs(migration.up).length < 3) {
        // support old callback-based migrations prior to migrate-mongo 7.x.x
        await up(db);
      } else {
        await up(db, client);
      }

    } catch (err) {
      const error = new Error(
        `Could not migrate up ${item.fileName}: ${err.message}`
      );
      error.stack = err.stack;
      error.migrated = migrated;
      throw error;
    }

    const { changelogCollectionName, useFileHash } = await config.read();
    const changelogCollection = db.collection(changelogCollectionName);

    const { fileName, fileHash } = item;
    const appliedAt = new Date();

    try {
      await changelogCollection.insertOne(useFileHash ? { fileName, fileHash, appliedAt, migrationBlock } : { fileName, appliedAt, migrationBlock });
    } catch (err) {
      throw new Error(`Could not update changelog: ${err.message}`);
    }
    migrated.push(item.fileName);
  };

  await pEachSeries(itemsToMigrate, migrateItem);
  return migrated;
};
