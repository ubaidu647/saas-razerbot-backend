/**
 * Seeds three starter packages if none exist. Safe to re-run.
 *
 *   node scripts/seedPackages.js
 */
require('dotenv').config({ path: '.env' });
const mongoose = require('mongoose');
const connectDB = require('../src/db');
const Package = require('../src/modules/packages/package.model');

const STARTER_PACKAGES = [
  { name: 'Basic',      description: 'Entry tier',        maxGoldAccounts: 1,    maxSilverAccounts: 1,    maxProxies: 1,    price: 0 },
  { name: 'Pro',        description: 'For small teams',   maxGoldAccounts: 10,   maxSilverAccounts: 10,   maxProxies: 5,    price: 49 },
  { name: 'Enterprise', description: 'Unlimited usage',   maxGoldAccounts: null, maxSilverAccounts: null, maxProxies: null, price: 199 },
];

async function main() {
  await connectDB();

  const count = await Package.estimatedDocumentCount();
  if (count > 0) {
    console.log(`Skipped — ${count} package(s) already exist.`);
  } else {
    await Package.insertMany(STARTER_PACKAGES);
    console.log(`Seeded ${STARTER_PACKAGES.length} packages.`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
