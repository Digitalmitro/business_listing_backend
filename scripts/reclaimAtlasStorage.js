"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { finished } = require("node:stream/promises");
const { createGzip } = require("node:zlib");
const { EJSON } = require("bson");
const { MongoClient } = require("mongodb");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });
process.umask(0o077);

const TARGET_DATABASE = "businessListing";
const execute = process.argv.includes("--execute");
const confirmed = process.argv.includes("--confirm-business-listing");

function toMiB(bytes) {
  return Number(((bytes || 0) / 1024 / 1024).toFixed(2));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function collectionSnapshot(db, name) {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) return { name, exists: false, documents: 0, dataMiB: 0, indexesMiB: 0 };

  const [documents, stats] = await Promise.all([
    db.collection(name).countDocuments({}),
    db.command({ collStats: name }),
  ]);
  return {
    name,
    exists: true,
    documents,
    dataMiB: toMiB(stats.size),
    storageMiB: toMiB(stats.storageSize),
    indexesMiB: toMiB(stats.totalIndexSize),
  };
}

async function backupCollection(db, name, directory) {
  const collection = db.collection(name);
  const expectedCount = await collection.countDocuments({});
  const filePath = path.join(directory, `${name}.extended-json.ndjson.gz`);
  const output = fs.createWriteStream(filePath, { mode: 0o600 });
  const gzip = createGzip({ level: 9 });
  gzip.pipe(output);

  let backedUpCount = 0;
  try {
    for await (const document of collection.find({})) {
      const line = `${EJSON.stringify(document, { relaxed: false })}\n`;
      if (!gzip.write(line)) await once(gzip, "drain");
      backedUpCount += 1;
    }
    gzip.end();
    await finished(output);
  } catch (error) {
    gzip.destroy(error);
    output.destroy(error);
    throw error;
  }

  const finalCount = await collection.countDocuments({});
  if (backedUpCount !== expectedCount || finalCount !== expectedCount) {
    throw new Error(
      `${name} changed during backup (expected ${expectedCount}, backed up ${backedUpCount}, now ${finalCount}); cleanup aborted.`
    );
  }

  const fileStats = await fs.promises.stat(filePath);
  return {
    collection: name,
    documents: backedUpCount,
    file: filePath,
    compressedMiB: toMiB(fileStats.size),
  };
}

async function dropIfPresent(db, name) {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) return false;
  await db.collection(name).drop();
  return true;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is required in the backend .env file.");
  if (execute && !confirmed) {
    throw new Error("Refusing cleanup without --confirm-business-listing.");
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  try {
    const db = client.db();
    if (db.databaseName !== TARGET_DATABASE) {
      throw new Error(
        `Refusing to operate on ${db.databaseName}; this utility is restricted to ${TARGET_DATABASE}.`
      );
    }

    const before = await Promise.all([
      collectionSnapshot(db, "businesses"),
      collectionSnapshot(db, "businessimportrows"),
      collectionSnapshot(db, "businessimportbatches"),
      collectionSnapshot(db, "geocodecaches"),
    ]);
    const databaseBefore = await db.command({ dbStats: 1 });

    if (!execute) {
      console.log(
        JSON.stringify(
          {
            mode: "dry-run",
            database: db.databaseName,
            quotaBasisMiB: toMiB(databaseBefore.dataSize + databaseBefore.indexSize),
            collections: before,
            proposedCleanup: {
              preserves: ["businesses", "businessimportbatches"],
              backsUpThenDrops: ["businessimportrows"],
              dropsRegenerableCache: ["geocodecaches"],
            },
          },
          null,
          2
        )
      );
      return;
    }

    const backupDirectory = path.resolve(__dirname, "../../.atlas-backups", timestamp());
    await fs.promises.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const backups = [];
    backups.push(await backupCollection(db, "businessimportrows", backupDirectory));
    backups.push(await backupCollection(db, "businessimportbatches", backupDirectory));

    const manifestPath = path.join(backupDirectory, "manifest.json");
    await fs.promises.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          database: db.databaseName,
          purpose: "Backup before reclaiming generated import audit and geocode cache storage",
          backups,
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );

    const droppedImportRows = await dropIfPresent(db, "businessimportrows");
    const droppedGeocodeCache = await dropIfPresent(db, "geocodecaches");
    const stoppedBatches = await db.collection("businessimportbatches").updateMany(
      { status: "processing" },
      {
        $set: {
          status: "failed",
          completedAt: new Date(),
          failureReason:
            "Import stopped when the Atlas storage quota was exceeded. Generated audit and cache storage was reclaimed; re-upload the file.",
        },
      }
    );

    const databaseAfter = await db.command({ dbStats: 1 });
    console.log(
      JSON.stringify(
        {
          mode: "executed",
          database: db.databaseName,
          backupDirectory,
          backups,
          preservedBusinessDocuments:
            before.find((collection) => collection.name === "businesses")?.documents || 0,
          droppedImportRows,
          droppedGeocodeCache,
          stoppedProcessingBatches: stoppedBatches.modifiedCount,
          quotaBasisBeforeMiB: toMiB(databaseBefore.dataSize + databaseBefore.indexSize),
          quotaBasisAfterMiB: toMiB(databaseAfter.dataSize + databaseAfter.indexSize),
        },
        null,
        2
      )
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`Atlas storage cleanup failed: ${error.message}`);
  process.exitCode = 1;
});
