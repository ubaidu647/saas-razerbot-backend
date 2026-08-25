const RazerAccount = require('./razerAccount.model');

/**
 * Claims a slot for each successfully loaded account. Called after a bulk load
 * so failed logins never burn a slot.
 */
async function registerLoaded(ownerId, type, emails) {
  if (!emails.length) return { claimed: 0 };

  const ops = emails.map((email) => ({
    updateOne: {
      filter: { ownerId, email: String(email).toLowerCase().trim(), type },
      update: {
        $set: { status: 'active', lastLoadedAt: new Date(), lastError: '' },
        $setOnInsert: { ownerId, email: String(email).toLowerCase().trim(), type },
      },
      upsert: true,
    },
  }));

  const res = await RazerAccount.bulkWrite(ops, { ordered: false });
  return { claimed: (res.upsertedCount || 0) + (res.modifiedCount || 0) };
}

async function listForOwner(ownerId, type) {
  const filter = { ownerId, status: 'active' };
  if (type) filter.type = type;
  return RazerAccount.find(filter).sort({ createdAt: -1 }).lean();
}

/** Frees a slot so the owner can load a different account in its place. */
async function release(ownerId, accountId) {
  return RazerAccount.findOneAndUpdate(
    { _id: accountId, ownerId },
    { $set: { status: 'released' } },
    { new: true }
  );
}

module.exports = { registerLoaded, listForOwner, release };
