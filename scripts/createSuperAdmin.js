/**
 * Creates (or updates) the super admin account.
 *
 *   node scripts/createSuperAdmin.js <email> <password> [name]
 *
 * Re-running with an existing email resets that admin's password, which is the
 * intended recovery path if the credentials are lost.
 */
require('dotenv').config({ path: '.env' });
const mongoose = require('mongoose');
const connectDB = require('../src/db');
const PortalUser = require('../src/modules/portal/portalUser.model');
const { hashPassword } = require('../src/utils/hash');

async function main() {
  const [email, password, ...nameParts] = process.argv.slice(2);

  if (!email || !password) {
    console.error('Usage: node scripts/createSuperAdmin.js <email> <password> [name]');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  await connectDB();

  const normalized = email.toLowerCase().trim();
  const existing = await PortalUser.findOne({ email: normalized });

  if (existing) {
    existing.password = await hashPassword(password);
    existing.role = 'superadmin';
    existing.status = 'active';
    existing.refreshToken = null;
    if (nameParts.length) existing.name = nameParts.join(' ');
    await existing.save();
    console.log(`Updated existing super admin: ${normalized}`);
  } else {
    await PortalUser.create({
      name: nameParts.join(' ') || 'Super Admin',
      email: normalized,
      password: await hashPassword(password),
      role: 'superadmin',
      status: 'active',
    });
    console.log(`Created super admin: ${normalized}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
