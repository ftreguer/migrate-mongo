const _ = require("lodash");
const pEachSeries = require("p-each-series");
const { promisify } = require("util");
const fnArgs = require('fn-args');

const status = require("./status");
const config = require("../env/config");
const migrationsDir = require("../env/migrationsDir");
const hasCallback = require('../utils/has-callback');

const getItemsToRollback = async db => {
  const isBlockRollback = _.get(global.options, "block");
  const targetedFileName = _.get(global.options, "target");

  if (isBlockRollback && targetedFileName) {
    throw new Error("Options -b (--block) and -t (--target) are incompatible. You must choose either one OR the other.");
  }

  const statusItems = await status(db);

  const appliedItems = statusItems.filter(item => item.appliedAt !== "PENDING");

  if (targetedFileName && !_.find(appliedItems, { fileName: targetedFileName })) {
    throw new Error(`File ${targetedFileName} is not part of the already migrated files`);
  }

  const lastAppliedItem = _.last(appliedItems);
  
  if (isBlockRollback && lastAppliedItem.migrationBlock) {
    return appliedItems.filter(item => item.migrationBlock === lastAppliedItem.migrationBlock).reverse();
  } 
  
  if (targetedFileName) {
    return _.takeRightWhile(appliedItems, ({ fileName }) => fileName > targetedFileName).reverse();
  } 
  
  return [lastAppliedItem];
}

module.exports = async (db, client) => {
  const itemsToRollback = await getItemsToRollback(db);
  const downgraded = [];

  const rollbackItem = async item => {
    if (item) {
      try {
        const migration = await migrationsDir.loadMigration(item.fileName);
        const down = hasCallback(migration.down) ? promisify(migration.down) : migration.down;
  
        if (hasCallback(migration.down) && fnArgs(migration.down).length < 3) {
          // support old callback-based migrations prior to migrate-mongo 7.x.x
          await down(db);
        } else {
          await down(db, client);
        }
  
      } catch (err) {
        throw new Error(
          `Could not migrate down ${item.fileName}: ${err.message}`
        );
      }
      const { changelogCollectionName } = await config.read();
      const changelogCollection = db.collection(changelogCollectionName);
      try {
        await changelogCollection.deleteOne({ fileName: item.fileName });
        downgraded.push(item.fileName);
      } catch (err) {
        throw new Error(`Could not update changelog: ${err.message}`);
      }
    }
  }

  await pEachSeries(itemsToRollback, rollbackItem);
  return downgraded;
};
