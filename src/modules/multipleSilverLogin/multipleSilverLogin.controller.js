const { loadAccounts, authenticateAccounts, transactAccounts, getProductBalance, getSilverBalances, getGoldBalances, bulkRedeemSilver, checkProxyHealth } = require('./multipleSilverLogin.service');
const RazerPayloadData = require('../auth/razerPayloadData.model');
const SilverMultipleTransaction = require('./silverMultipleTransaction.model');
const logStore = require('../../utils/logStore');
const { assertCanLoadAccounts, getUsageSummary } = require('../packages/limits.service');
const razerAccountService = require('../razerAccounts/razerAccount.service');

async function debugPayload(req, res) {
  const doc = await RazerPayloadData.findOne({ email: req.params.email });
  if (!doc) return res.json({ found: false });
  res.json({
    found: true,
    email: doc.email,
    hasAccessToken: !!doc.xRazerAccessToken,
    xRazerAccessToken: doc.xRazerAccessToken?.substring(0, 20) + '...',
    hasCookieHeader: !!doc.cookieHeader,
    hasRazerIdAuthToken: !!doc.razerIdAuthToken,
    capturedAt: doc.capturedAt,
  });
}

const MAX_ACCOUNTS = 200;

function getAutoBatchSize(count) {
  if (count <= 30)  return 10;
  if (count <= 60)  return 15;
  if (count <= 100) return 20;
  if (count <= 200) return 25;
  return 25;
}

function validateAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0)
    return 'accounts array is required';
  if (accounts.length > MAX_ACCOUNTS)
    return `Maximum ${MAX_ACCOUNTS} accounts allowed per request`;
  const invalid = accounts.filter(a => !a.email || !a.password);
  if (invalid.length > 0)
    return `${invalid.length} accounts missing email or password`;
  return null;
}

// Gold and silver are capped independently by the caller's package.
function resolveAccountType(type) {
  return type === 'gold' ? 'gold' : 'silver';
}

// Claim a slot only for accounts that actually logged in, so a failed batch
// never eats into the package allowance.
async function claimLoadedSlots(req, accountType, result) {
  const loaded = (result.results || []).filter(r => r.success).map(r => r.email);
  if (loaded.length) await razerAccountService.registerLoaded(req.portalUserId, accountType, loaded);
  return loaded.length;
}

async function bulkLoad(req, res, next) {
  try {
    const { accounts, batchSize, type } = req.body;

    const error = validateAccounts(accounts);
    if (error) return res.status(400).json({ success: false, message: error });

    const resolvedBatchSize = batchSize || getAutoBatchSize(accounts.length);
    const accountType = resolveAccountType(type);

    // Enforce the package cap before doing any network work.
    await assertCanLoadAccounts(req.portalUser, accountType, accounts.map(a => a.email));

    const result = await loadAccounts(accounts, { batchSize: resolvedBatchSize, type, ownerId: req.portalUserId });
    await claimLoadedSlots(req, accountType, result);

    res.json({
      success: true,
      total: result.total,
      loaded: result.success,
      failed: result.failed,
      elapsed: result.elapsed,
      batchSize: resolvedBatchSize,
      results: result.results,
      usage: await getUsageSummary(req.portalUser),
    });
  } catch (err) {
    next(err);
  }
}

// SSE version — streams live progress to frontend
async function bulkLoadStream(req, res, next) {
  try {
    const { accounts, batchSize, type } = req.body;

    const error = validateAccounts(accounts);
    if (error) return res.status(400).json({ success: false, message: error });

    const resolvedBatchSize = batchSize || getAutoBatchSize(accounts.length);
    const accountType = resolveAccountType(type);

    // Check the cap before opening the SSE stream so a rejection is a plain
    // JSON 403 the client can surface directly.
    try {
      await assertCanLoadAccounts(req.portalUser, accountType, accounts.map(a => a.email));
    } catch (limitErr) {
      return res.status(limitErr.status || 403).json({
        success: false,
        code: limitErr.code,
        message: limitErr.message,
        details: limitErr.details,
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send('start', { total: accounts.length, batchSize: resolvedBatchSize });

    const result = await loadAccounts(accounts, {
      batchSize: resolvedBatchSize,
      type,
      ownerId: req.portalUserId,
      onProgress: (account, done, total) => {
        send('progress', { done, total, account });
      },
    });

    await claimLoadedSlots(req, accountType, result);

    send('done', {
      total: result.total,
      loaded: result.success,
      failed: result.failed,
      elapsed: result.elapsed,
      usage: await getUsageSummary(req.portalUser),
    });

    res.end();
  } catch (err) {
    next(err);
  }
}

async function bulkAuthenticate(req, res, next) {
  try {
    const { accounts } = req.body;
    if (!Array.isArray(accounts) || accounts.length === 0)
      return res.status(400).json({ success: false, message: 'accounts array is required' });

    const result = await authenticateAccounts(accounts);

    res.json({
      success: true,
      total: result.total,
      authenticated: result.success,
      failed: result.failed,
      elapsed: result.elapsed,
      results: result.results,
    });
  } catch (err) {
    next(err);
  }
}

async function bulkTransact(req, res, next) {
  try {
    const { accounts, product, batchSize } = req.body;

    if (!Array.isArray(accounts) || accounts.length === 0)
      return res.status(400).json({ success: false, message: 'accounts array is required' });

    const invalid = accounts.filter(a => !a.email || !a.authenticatorCode);
    if (invalid.length > 0)
      return res.status(400).json({ success: false, message: `${invalid.length} accounts missing email or authenticatorCode` });

    const requiredProduct = ['productId', 'regionId', 'paymentChannelId', 'permalink'];
    const missingProduct = requiredProduct.filter(f => !product?.[f]);
    if (missingProduct.length > 0)
      return res.status(400).json({ success: false, message: `product missing: ${missingProduct.join(', ')}` });

    const result = await transactAccounts(accounts, product, { batchSize: batchSize || 10 });

    res.json({
      success: true,
      total: result.total,
      succeeded: result.success,
      failed: result.failed,
      elapsed: result.elapsed,
      results: result.results,
    });
  } catch (err) {
    next(err);
  }
}


async function productBalance(req, res, next) {
  try {
    const { permalink } = req.params;
    if (!permalink)
      return res.status(400).json({ success: false, message: 'permalink is required' });

    const razerPayload = await RazerPayloadData.findOne({ userId: req.userId });
    if (!razerPayload || !razerPayload.xRazerAccessToken)
      return res.status(400).json({ success: false, message: 'No Razer session found. Please log in first.' });

    const data = await getProductBalance({ permalink, razerPayload });

    res.json({ success: true, ...data });
  } catch (err) {
    next(err);
  }
}

async function bulkSilverBalance(req, res, next) {
  try {
    const { accounts, emails } = req.body;
    const emailList = accounts?.length
      ? accounts.map(a => a.email)
      : (emails || []);
    const result = await getSilverBalances(emailList);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function bulkGoldBalance(req, res, next) {
  try {
    const { accounts, emails } = req.body;
    const emailList = accounts?.length
      ? accounts.map(a => a.email)
      : (emails || []);
    const result = await getGoldBalances(emailList);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function bulkSilverRedeem(req, res, next) {
  try {
    const { accounts, product, country, batchSize } = req.body;

    if (!Array.isArray(accounts) || accounts.length === 0)
      return res.status(400).json({ success: false, message: 'accounts array is required' });

    const missingOtp = accounts.filter(a => !a.email || !a.rzrotptoken || !a.otp_token_enc || !a.otp_token);
    if (missingOtp.length > 0)
      return res.status(400).json({ success: false, message: `${missingOtp.length} accounts missing OTP tokens — run 2FA step first` });

    const requiredProduct = ['zSilver_id', 'region_id', 'silver_reward_id', 'amount'];
    const missingProduct = requiredProduct.filter(f => !product?.[f]);
    if (missingProduct.length > 0)
      return res.status(400).json({ success: false, message: `product missing: ${missingProduct.join(', ')}` });

    const result = await bulkRedeemSilver(accounts, product, { batchSize: batchSize || 20, country });

    const saved = await SilverMultipleTransaction.create({
      userId: req.userId,
      country: country || 'United States',
      product,
      total: result.total,
      redeemed: result.redeemed,
      receiptsOk: result.receiptsOk,
      failed: result.failed,
      elapsed: result.elapsed,
      phase1Elapsed: result.phase1Elapsed,
      proxiesUsed: result.proxiesUsed,
      results: result.results,
    });

    res.json({ success: true, _id: saved._id, ...result });
  } catch (err) {
    next(err);
  }
}

async function proxyHealth(req, res, next) {
  try {
    const results = await checkProxyHealth();
    res.json({ success: true, results });
  } catch (err) {
    next(err);
  }
}

async function getLogs(req, res) {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ logs: logStore.getLogs(limit) });
}

async function clearLogs(req, res) {
  logStore.clear();
  res.json({ success: true, message: 'Logs cleared' });
}

module.exports = { bulkLoad, bulkLoadStream, bulkAuthenticate, debugPayload, bulkTransact, productBalance, bulkSilverBalance, bulkGoldBalance, bulkSilverRedeem, getLogs, clearLogs, proxyHealth };
