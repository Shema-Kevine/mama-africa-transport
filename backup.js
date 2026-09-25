'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const source = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'data', 'mama-africa.sqlite'));
const backupDirectory = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, 'backups'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.join(backupDirectory, `mama-africa-${stamp}.sqlite`);

if (!fs.existsSync(source)) {
  console.error(`Database not found: ${source}`);
  process.exit(1);
}
fs.mkdirSync(backupDirectory, { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
const escapedDestination = destination.replace(/'/g, "''");
db.exec(`VACUUM INTO '${escapedDestination}'`);
db.close();
console.log(`Backup written to ${destination}`);
