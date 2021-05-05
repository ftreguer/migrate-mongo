const { expect } = require("chai");
const sinon = require("sinon");

const proxyquire = require("proxyquire");

describe("up", () => {
  let up;
  let status;
  let config;
  let migrationsDir;
  let db;
  let client;

  let firstPendingMigration;
  let secondPendingMigration;
  let thirdPendingMigration;
  let changelogCollection;

  function mockStatus() {
    return sinon.stub().returns(
      Promise.resolve([
        {
          fileName: "20160605123224-first_applied_migration.js",
          appliedAt: new Date(),
          fileHash: 'appliedHash1'
        },
        {
          fileName: "20160606093207-second_applied_migration.js",
          appliedAt: new Date(),
          fileHash: 'appliedHash2'
        },
        {
          fileName: "20160607173840-first_pending_migration.js",
          appliedAt: "PENDING",
          fileHash: 'pendingHash1'
        },
        {
          fileName: "20160608060209-second_pending_migration.js",
          appliedAt: "PENDING",
          fileHash: 'pendingHash2'
        },
        {
          fileName: "20160609173445-third_pending_migration.js",
          appliedAt: "PENDING",
          fileHash: 'pendingHash3'
        }
      ])
    );
  }

  function mockConfig({ useFileHash = false } = {}) {
    return {
      shouldExist: sinon.stub().returns(Promise.resolve()),
      read: sinon.stub().returns({
        changelogCollectionName: "changelog",
        useFileHash
      })
    };
  }

  function mockMigrationsDir() {
    const mock = {};
    mock.loadMigration = sinon.stub();
    mock.loadMigration
      .withArgs("20160607173840-first_pending_migration.js")
      .returns(Promise.resolve(firstPendingMigration));
    mock.loadMigration
      .withArgs("20160608060209-second_pending_migration.js")
      .returns(Promise.resolve(secondPendingMigration));
    mock.loadMigration
      .withArgs("20160609173445-third_pending_migration.js")
      .returns(Promise.resolve(thirdPendingMigration));
    return mock;
  }

  function mockDb() {
    const mock = {};
    mock.collection = sinon.stub();
    mock.collection.withArgs("changelog").returns(changelogCollection);
    return mock;
  }

  function mockClient() {
    return { the: 'client' };
  }

  function mockMigration() {
    const migration = {
      up: sinon.stub()
    };
    migration.up.returns(Promise.resolve());
    return migration;
  }

  function mockChangelogCollection() {
    return {
      insertOne: sinon.stub().returns(Promise.resolve())
    };
  }

  function loadUpWithInjectedMocks() {
    return proxyquire("../../lib/actions/up", {
      "./status": status,
      "../env/config": config,
      "../env/migrationsDir": migrationsDir
    });
  }

  beforeEach(() => {
    global.options = {};
    
    firstPendingMigration = mockMigration();
    secondPendingMigration = mockMigration();
    thirdPendingMigration = mockMigration();
    changelogCollection = mockChangelogCollection();

    status = mockStatus();
    config = mockConfig();
    migrationsDir = mockMigrationsDir();
    db = mockDb();
    client = mockClient();

    up = loadUpWithInjectedMocks();
  });

  it("should fetch the status", async () => {
    await up(db);
    expect(status.called).to.equal(true);
  });

  it("should load all the pending migrations", async () => {
    await up(db);
    expect(migrationsDir.loadMigration.called).to.equal(true);
    expect(migrationsDir.loadMigration.callCount).to.equal(3);
    expect(migrationsDir.loadMigration.getCall(0).args[0]).to.equal(
      "20160607173840-first_pending_migration.js"
    );
    expect(migrationsDir.loadMigration.getCall(1).args[0]).to.equal(
      "20160608060209-second_pending_migration.js"
    );
    expect(migrationsDir.loadMigration.getCall(2).args[0]).to.equal(
      "20160609173445-third_pending_migration.js"
    );
  });

  it("should upgrade all pending migrations in ascending order", async () => {
    await up(db);
    expect(firstPendingMigration.up.called).to.equal(true);
    expect(secondPendingMigration.up.called).to.equal(true);
    expect(thirdPendingMigration.up.called).to.equal(true);
    sinon.assert.callOrder(firstPendingMigration.up, secondPendingMigration.up, thirdPendingMigration.up);
  });

  it("should be able to upgrade callback based migration that has both the `db` and `client` args", async () => {
    firstPendingMigration = {
      up(theDb, theClient, callback) {
        return callback();
      }
    };
    migrationsDir = mockMigrationsDir();
    up = loadUpWithInjectedMocks();
    await up(db, client);
  });

  it("should be able to upgrade callback based migration that has only the `db` arg", async () => {
    firstPendingMigration = {
      up(theDb, callback) {
        return callback();
      }
    };
    migrationsDir = mockMigrationsDir();
    up = loadUpWithInjectedMocks();
    await up(db, client);
  });

  it("should populate the changelog with info about the upgraded migrations", async () => {
    const clock = sinon.useFakeTimers(
      new Date("2016-06-09T08:07:00.077Z").getTime()
    );
    await up(db);

    expect(changelogCollection.insertOne.called).to.equal(true);
    expect(changelogCollection.insertOne.callCount).to.equal(3);
    expect(changelogCollection.insertOne.getCall(0).args[0]).to.deep.equal({
      appliedAt: new Date("2016-06-09T08:07:00.077Z"),
      fileName: "20160607173840-first_pending_migration.js",
      migrationBlock: 1465459620077
    });
    clock.restore();
  });

  it("should populate the changelog with info about the upgraded migrations, using file hash", async () => {
    const clock = sinon.useFakeTimers(
      new Date("2016-06-09T08:07:00.077Z").getTime()
    );

    config = mockConfig({ useFileHash: true })
    up = loadUpWithInjectedMocks();

    await up(db);

    expect(changelogCollection.insertOne.called).to.equal(true);
    expect(changelogCollection.insertOne.callCount).to.equal(3);
    expect(changelogCollection.insertOne.getCall(0).args[0]).to.deep.equal({
      appliedAt: new Date("2016-06-09T08:07:00.077Z"),
      fileName: "20160607173840-first_pending_migration.js",
      migrationBlock: 1465459620077,
      fileHash: "pendingHash1"
    });
    clock.restore();
  });

  it("should yield a list of upgraded migration file names", async () => {
    const upgradedFileNames = await up(db);
    expect(upgradedFileNames).to.deep.equal([
      "20160607173840-first_pending_migration.js",
      "20160608060209-second_pending_migration.js",
      "20160609173445-third_pending_migration.js"
    ]);
  });

  it("should stop migrating when an error occurred and yield the error", async () => {
    secondPendingMigration.up.returns(Promise.reject(new Error("Nope")));
    try {
      await up(db);
      expect.fail("Error was not thrown");
    } catch (err) {
      expect(err.message).to.deep.equal(
        "Could not migrate up 20160608060209-second_pending_migration.js: Nope"
      );
    }
  });

  it("should yield an error + items already migrated when unable to update the changelog", async () => {
    changelogCollection.insertOne
      .onSecondCall()
      .returns(Promise.reject(new Error("Kernel panic")));
    try {
      await up(db);
      expect.fail("Error was not thrown");
    } catch (err) {
      expect(err.message).to.deep.equal(
        "Could not update changelog: Kernel panic"
      );
    }
  });

  it("should yield an error if both block and target options are requested", async () => {
    global.options = { next: true, target: "20190927150918-any_migration.js" };

    try  {
      await up(db);
      expect.fail('Should have thrown an error');
    } catch (err) {
      expect(err.message).to.equal(
        "Options -n (--next) and -t (--target) are incompatible. You must choose either one OR the other."
      );
    }
  });

  it("should yield an error if targeted file name is not part of the pending migrations", async () => {
    global.options = { target: "20190927150918-any-migration.js" };

    try  {
      await up(db);
      expect.fail('Should have thrown an error');
    } catch (err) {
      expect(err.message).to.equal(
        "File 20190927150918-any-migration.js is not part of the pending migrations"
      );
    }
  });

  it("should migrate only next pending migration", async () => {
    global.options = { next: true };

    const items = await up(db);
    expect(items).to.deep.equal(["20160607173840-first_pending_migration.js"]);
  });

  it("should migrate each pending migration until the targeted one (included)", async () => {
    global.options = { target: "20160608060209-second_pending_migration.js" };
    
    const items = await up(db);
    expect(items).to.deep.equal([
      "20160607173840-first_pending_migration.js",
      "20160608060209-second_pending_migration.js"
    ]);
  });
});
