const { loginOneAccount } = require('../../utils/razerLogin');
const { saveRazerPayloadData, registerRazerBrowserLogin } = require('../auth/auth.service');
const speakeasy = require('speakeasy');
const RazerPayloadData = require('../auth/razerPayloadData.model');
const { getAxiosForUser, PROXY_LIST } = require('../../utils/proxyAxios');

function getRotatingProxies(count = 3) {
  const active = PROXY_LIST.filter(p => !p.disabled);
  return active.slice(0, Math.min(count, active.length));
}

// Razer returns error 70610 "transaction number is not unique" when concurrent redeems on
// the same session collide and Razer generates a duplicate transaction number. Transient
// race, safe to retry. Detect it across the shapes Razer may use.
function isTransactionNotUnique(body) {
  if (!body) return false;
  const code = body.code ?? body.errorCode ?? body.error_code ?? body.status;
  if (String(code) === '70610') return true;
  try {
    const s = JSON.stringify(body).toLowerCase();
    if (s.includes('70610')) return true;
    if (s.includes('not unique') && s.includes('transaction')) return true;
  } catch {}
  return false;
}

function assignProxy(index, proxies) {
  if (!proxies.length) return null;
  return proxies[index % proxies.length];
}

const CLIENT_ID = process.env.RAZER_CLIENT_ID || '63c74d17e027dc11f642146bfeeaee09c3ce23d8';
const SSO_CLIENT_ID = process.env.LAST_CLIENT_ID_PASSED || '63c74d17e027dc11f642146bfeeaee09c3ce23d8';

async function refreshAccessToken(razerPayload) {
  try {
    const axiosInstance = await getAxiosForUser(razerPayload.userId);
    const res = await axiosInstance.post(
      'https://oauth2.razer.com/services/sso',
      new URLSearchParams({ client_id: SSO_CLIENT_ID, client_key: 'enZhdWx0', scope: 'sso cop' }).toString(),
      {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'content-type': 'application/x-www-form-urlencoded',
          'cookie': razerPayload.cookieHeader || '',
          'Origin': 'https://gold.razer.com',
          'Referer': 'https://gold.razer.com/',
        },
        validateStatus: () => true,
      }
    );
    const newToken = res.data?.access_token || null;
    if (newToken) {
      await RazerPayloadData.findOneAndUpdate(
        { _id: razerPayload._id },
        { $set: { xRazerAccessToken: newToken, capturedAt: new Date() } }
      );
      razerPayload.xRazerAccessToken = newToken;
    }
    return newToken;
  } catch {
    return null;
  }
}

async function loadAccounts(accounts, { batchSize = 20, onProgress, type, ownerId = null } = {}) {
  const results = [];
  const start = Date.now();
  // Gold multi-account login uses the server's own IP; silver keeps rotating proxies.
  const useProxy = type !== 'gold';
  const proxies = useProxy ? getRotatingProxies(9) : [];

  for (let i = 0; i < accounts.length; i += batchSize) {
    const batch = accounts.slice(i, i + batchSize);

    const batchResults = await Promise.allSettled(
      batch.map((account, batchIdx) => {
        const stagger = batchIdx * 100;
        return new Promise(r => setTimeout(r, stagger))
          .then(() => loginAndSave(account, useProxy ? assignProxy(i + batchIdx, proxies) : null, ownerId));
      })
    );

    batchResults.forEach((r, idx) => {
      const result = r.status === 'fulfilled'
        ? r.value
        : { email: batch[idx].email, success: false, error: r.reason?.message || 'Unknown error' };
      results.push(result);
      if (onProgress) onProgress(result, results.length, accounts.length);
    });

    if (i + batchSize < accounts.length) await new Promise(r => setTimeout(r, 300));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const successCount = results.filter(r => r.success).length;

  return {
    total: accounts.length,
    success: successCount,
    failed: accounts.length - successCount,
    elapsed: `${elapsed}s`,
    results,
  };
}

async function loginAndSave(account, proxy = null, ownerId = null) {
  const { email, password, serviceCode = '0060' } = account;

  const loginResult = await loginOneAccount({ email, password, serviceCode, proxy });

  if (!loginResult.success) {
    return { email, success: false, error: loginResult.error, raw: loginResult.raw, consentResponse: loginResult.consentResponse };
  }

  // Register or update user in DB
  const authResult = await registerRazerBrowserLogin({ name: email, email, password, ownerId });

  // Save tokens to DB (store oauth session cookies in razerIdAuthToken for authenticate step)
  await saveRazerPayloadData({
    userId: authResult.user.id,
    email,
    username: email,
    payload: {
      cookieHeader: loginResult.cookieHeader,
      cookies: [],
      xRazerAccessToken: loginResult.xRazerAccessToken,
      xRazerFpid: loginResult.xRazerFpid,
      xRazerRazerid: loginResult.xRazerRazerid,
      razerIdAuthToken: loginResult.oauthCookieHeader || '',
      rawHeaders: {},
      referer: process.env.RAZER_GOLD_URL || 'https://gold.razer.com/global/en',
      currentUrl: process.env.RAZER_GOLD_URL || 'https://gold.razer.com/global/en',
    },
  });

  return {
    email,
    success: true,
    userId: authResult.user.id,
    hasAccessToken: !!loginResult.xRazerAccessToken,
  };
}

async function authenticateOneAccount({ email, authenticatorCode }, proxy = null) {
  const payload = await RazerPayloadData.findOne({ email }).sort({ capturedAt: -1 });
  if (!payload) {
    return { email, success: false, error: 'Account not loaded — run /load first' };
  }

  const otpToken = speakeasy.totp({ secret: authenticatorCode, encoding: 'base32' });
  const clientId = process.env.LAST_CLIENT_ID_PASSED || '63c74d17e027dc11f642146bfeeaee09c3ce23d8';

  // Use rotation proxy if provided, otherwise fall back to user's assigned proxy
  let axiosInstance;
  if (proxy) {
    const { buildAxiosWithProxy } = require('../../utils/proxyAxios');
    axiosInstance = buildAxiosWithProxy ? buildAxiosWithProxy(proxy.id) : await getAxiosForUser(payload.userId);
  } else {
    axiosInstance = await getAxiosForUser(payload.userId);
  }

  let otpRes;
  try {
    otpRes = await axiosInstance.post(
      'https://razer-otptoken-service.razer.com/totp/post',
      { client_id: clientId, token: otpToken },
      {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          'access-control-allow-origin': '*',
          'authorization': `Bearer ${payload.xRazerAccessToken}`,
          'cache-control': 'no-cache',
          'content-type': 'application/json',
          'pragma': 'no-cache',
          'cookie': payload.cookieHeader || '',
          'Origin': 'https://razerid.razer.com',
          'Referer': 'https://razerid.razer.com/',
        },
        validateStatus: () => true,
      }
    );
  } catch (err) {
    return { email, success: false, error: `OTP request failed: ${err.message}` };
  }

  if (otpRes.status !== 200) {
    console.log(`[otp-debug] ${email} status=${otpRes.status} body=${JSON.stringify(otpRes.data)} token_len=${payload.xRazerAccessToken?.length}`);
    return { email, success: false, error: `OTP service error (${otpRes.status}): ${JSON.stringify(otpRes.data)}` };
  }

  const setCookieHeader = otpRes.headers['set-cookie'];
  const setCookie = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : (setCookieHeader || '');
  const rzrotptokenMatch = setCookie.match(/_rzrotptoken=([^;]+)/);
  const rzrotptokenTsMatch = setCookie.match(/_rzrotptokents=([^;]+)/);
  const rzrotptoken = rzrotptokenMatch ? rzrotptokenMatch[1] : null;
  const rzrotptokenTs = rzrotptokenTsMatch ? rzrotptokenTsMatch[1] : null;

  if (!rzrotptoken) {
    return { email, success: false, error: 'OTP service did not return _rzrotptoken cookie' };
  }

  const otpBody = otpRes.data || {};
  const otp_token_enc = otpBody.otp_token_enc || null;
  const otp_token = otpBody.otp_token || null;
  const create_ts = otpBody.create_ts || null;

  return { email, success: true, rzrotptoken, rzrotptokenTs, otp_token_enc, otp_token, create_ts };
}

async function authenticateAccounts(accounts) {
  const results = [];
  const start = Date.now();
  const proxies = getRotatingProxies(9);

  const settled = await Promise.allSettled(accounts.map((a, i) => authenticateOneAccount(a, assignProxy(i, proxies))));
  settled.forEach((r, idx) => {
    results.push(
      r.status === 'fulfilled'
        ? r.value
        : { email: accounts[idx].email, success: false, error: r.reason?.message || 'Unknown error' }
    );
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const successCount = results.filter(r => r.success).length;
  return { total: accounts.length, success: successCount, failed: accounts.length - successCount, elapsed: `${elapsed}s`, results };
}

async function transactOneAccount({ email, authenticatorCode, product }) {
  // Step 1 — Load stored session
  const razerPayload = await RazerPayloadData.findOne({ email }).sort({ capturedAt: -1 });
  if (!razerPayload) {
    return { email, success: false, error: 'Account not loaded — run /load first' };
  }
  if (!razerPayload.xRazerAccessToken) {
    return { email, success: false, error: 'No access token — re-run /load' };
  }

  // Step 2 — Generate OTP
  const clientId = process.env.LAST_CLIENT_ID_PASSED || '63c74d17e027dc11f642146bfeeaee09c3ce23d8';
  const otpToken = speakeasy.totp({ secret: authenticatorCode, encoding: 'base32' });
  const axiosInstance = await getAxiosForUser(razerPayload.userId);

  let otpRes;
  try {
    otpRes = await axiosInstance.post(
      'https://razer-otptoken-service.razer.com/totp/post',
      { client_id: clientId, token: otpToken },
      {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          'access-control-allow-origin': '*',
          'authorization': `Bearer ${razerPayload.xRazerAccessToken}`,
          'cache-control': 'no-cache',
          'content-type': 'application/json',
          'pragma': 'no-cache',
          'cookie': razerPayload.cookieHeader,
          'Origin': 'https://razerid.razer.com',
          'Referer': 'https://razerid.razer.com/',
        },
        validateStatus: () => true,
      }
    );
  } catch (err) {
    return { email, success: false, error: `OTP request failed: ${err.message}` };
  }

  if (otpRes.status !== 200) {
    return { email, success: false, error: `OTP service error (${otpRes.status}): ${JSON.stringify(otpRes.data)}` };
  }

  const setCookieHeader = otpRes.headers['set-cookie'];
  const setCookie = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : (setCookieHeader || '');
  const rzrotptokenMatch = setCookie.match(/_rzrotptoken=([^;]+)/);
  const rzrotptokenTsMatch = setCookie.match(/_rzrotptokents=([^;]+)/);
  const rzrotptoken = rzrotptokenMatch ? rzrotptokenMatch[1] : null;
  const rzrotptokenTs = rzrotptokenTsMatch ? rzrotptokenTsMatch[1] : null;

  if (!rzrotptoken) {
    return { email, success: false, error: 'OTP service did not return _rzrotptoken cookie' };
  }

  const otp_token_enc = otpRes.data?.otp_token_enc || null;
  const otp_token = otpRes.data?.otp_token || null;

  if (!otp_token_enc || !otp_token) {
    return { email, success: false, error: 'OTP body missing otp_token_enc or otp_token' };
  }

  // Step 3 — Checkout
  let checkoutRes;
  try {
    checkoutRes = await axiosInstance.post(
      'https://gold.razer.com/api/webshop/checkout/gold',
      {
        productId: product.productId,
        regionId: product.regionId,
        paymentChannelId: product.paymentChannelId,
        emailIsRequired: true,
        permalink: product.permalink,
        otpToken: otp_token_enc,
        savePurchaseDetails: true,
        personalizedInfo: [],
        email,
      },
      {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': 'no-cache',
          'content-type': 'application/json',
          'pragma': 'no-cache',
          'x-razer-accesstoken': razerPayload.xRazerAccessToken,
          'x-razer-fpid': razerPayload.xRazerFpid || '',
          'x-razer-language': 'en',
          'x-razer-razerid': razerPayload.xRazerRazerid || '',
          'cookie': `${razerPayload.cookieHeader}; _rzrotptoken=${rzrotptoken}; _rzrotptokents=${rzrotptokenTs}; otpToken=${encodeURIComponent(otp_token)}`,
          'Referer': `https://gold.razer.com/global/en/gold/catalog/${product.permalink}`,
        },
        validateStatus: () => true,
        maxRedirects: 0,
      }
    );
  } catch (err) {
    return { email, success: false, error: `Checkout request failed: ${err.message}` };
  }

  if (checkoutRes.status < 200 || checkoutRes.status >= 300) {
    return { email, success: false, error: `Checkout failed (${checkoutRes.status}): ${JSON.stringify(checkoutRes.data)}` };
  }

  const checkoutData = checkoutRes.data || {};
  const transactionId = checkoutData.transactionNumber;
  if (!transactionId) {
    return { email, success: false, error: `No transactionNumber in checkout response: ${JSON.stringify(checkoutData)}` };
  }

  // Step 4 — Get transaction result
  let resultRes;
  try {
    resultRes = await axiosInstance.get(`https://gold.razer.com/api/webshopv2/${transactionId}`, {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'x-razer-accesstoken': razerPayload.xRazerAccessToken,
        'x-razer-fpid': razerPayload.xRazerFpid || '',
        'x-razer-language': 'en',
        'x-razer-razerid': razerPayload.xRazerRazerid || '',
        'cookie': razerPayload.cookieHeader,
        'Referer': `https://gold.razer.com/global/en/gold/purchase/transaction/${transactionId}`,
      },
      validateStatus: () => true,
    });
  } catch (err) {
    return { email, success: true, transactionId, error: `Result fetch failed: ${err.message}` };
  }

  const resultData = resultRes.data || {};

  const pins = resultData?.fullfillment?.pins;
  const hasPins = Array.isArray(pins) && pins.length > 0;

  return {
    email,
    success: true,
    transactionId,
    transactionStatus: hasPins ? 'success' : 'reviewing',
    pins: pins || [],
    checkout: checkoutData,
    result: resultData,
  };
}

async function transactAccounts(accounts, product, { batchSize = 10, onProgress } = {}) {
  const results = [];
  const start = Date.now();

  for (let i = 0; i < accounts.length; i += batchSize) {
    const batch = accounts.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map(account => transactOneAccount({ ...account, product }))
    );
    settled.forEach((r, idx) => {
      const result = r.status === 'fulfilled'
        ? r.value
        : { email: batch[idx].email, success: false, error: r.reason?.message || 'Unknown error' };
      results.push(result);
      if (onProgress) onProgress(result, results.length, accounts.length);
    });
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const successCount = results.filter(r => r.success).length;
  return { total: accounts.length, success: successCount, failed: accounts.length - successCount, elapsed: `${elapsed}s`, results };
}

async function checkBalanceOneAccount({ email, balanceId }) {
  const razerPayload = await RazerPayloadData.findOne({ email }).sort({ capturedAt: -1 });
  if (!razerPayload) {
    return { email, success: false, error: 'Account not loaded — run /load first' };
  }

  let response;
  try {
    response = await fetch(`https://gold.razer.com/api/pincodes/balancev2/${balanceId}`, {
      method: 'GET',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'x-razer-accesstoken': razerPayload.xRazerAccessToken,
        'x-razer-fpid': razerPayload.xRazerFpid || '',
        'x-razer-razerid': razerPayload.xRazerRazerid || '',
        'cookie': razerPayload.cookieHeader,
        'Referer': 'https://gold.razer.com/',
      },
    });
  } catch (err) {
    return { email, success: false, error: `Balance request failed: ${err.message}` };
  }

  const bodyText = await response.text().catch(() => '');
  if (!response.ok) {
    return { email, success: false, error: `Balance API error (${response.status}): ${bodyText}` };
  }

  let data;
  try { data = JSON.parse(bodyText); } catch { data = {}; }

  return { email, success: true, data };
}

async function checkBalanceAccounts(emails, balanceId) {
  const start = Date.now();
  const settled = await Promise.allSettled(
    emails.map(email => checkBalanceOneAccount({ email, balanceId }))
  );
  const results = settled.map((r, idx) =>
    r.status === 'fulfilled'
      ? r.value
      : { email: emails[idx], success: false, error: r.reason?.message || 'Unknown error' }
  );
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const successCount = results.filter(r => r.success).length;
  return { total: emails.length, success: successCount, failed: emails.length - successCount, elapsed: `${elapsed}s`, results };
}

async function getProductBalance({ permalink, razerPayload }) {
  const axiosInstance = await getAxiosForUser(razerPayload.userId);

  // Step 1 — Fetch product info from catalog
  let catalogRes;
  try {
    catalogRes = await axiosInstance.get(`https://gold.razer.com/api/content/silver/catalogs/permalink/${permalink}`, {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'x-razer-fpid': razerPayload.xRazerFpid || '',
        'x-razer-language': 'en',
        'cookie': razerPayload.cookieHeader,
        'Referer': `https://gold.razer.com/global/en/silver/redeem/summary/${permalink}`,
      },
      validateStatus: () => true,
    });
  } catch (err) {
    throw new Error(`Catalog request failed: ${err.message}`);
  }

  if (catalogRes.status !== 200) throw new Error(`Catalog API error (${catalogRes.status}): ${JSON.stringify(catalogRes.data)}`);

  const product = catalogRes.data;
  const regionId = product?.regions?.[0]?.id;
  if (!regionId) throw new Error('No region ID found in product catalog response');

  // Step 2 — Fetch balance (auto-refresh token on 401)
  const doBalanceFetch = () => axiosInstance.get(`https://gold.razer.com/api/pincodes/balancev2/${regionId}`, {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
      'x-razer-accesstoken': razerPayload.xRazerAccessToken,
      'x-razer-fpid': razerPayload.xRazerFpid || '',
      'x-razer-razerid': razerPayload.xRazerRazerid || '',
      'cookie': razerPayload.cookieHeader,
      'Referer': `https://gold.razer.com/global/en/silver/redeem/summary/${permalink}`,
    },
    validateStatus: () => true,
  });

  let balanceRes;
  try { balanceRes = await doBalanceFetch(); } catch (err) {
    throw new Error(`Balance request failed: ${err.message}`);
  }

  if (balanceRes.status === 401) {
    const newToken = await refreshAccessToken(razerPayload);
    if (newToken) {
      try { balanceRes = await doBalanceFetch(); } catch (err) {
        throw new Error(`Balance request failed after token refresh: ${err.message}`);
      }
    }
  }

  if (balanceRes.status !== 200) throw new Error(`Balance API error (${balanceRes.status}): ${JSON.stringify(balanceRes.data)}`);

  return { product, regionId, balance: balanceRes.data };
}

async function getSilverBalanceOne(email, proxy = null) {
  const razerPayload = await RazerPayloadData.findOne({ email }).sort({ capturedAt: -1 });
  if (!razerPayload) return { email, success: false, error: 'Account not loaded' };

  let axiosInstance;
  if (proxy) {
    const { buildAxiosWithProxy } = require('../../utils/proxyAxios');
    axiosInstance = buildAxiosWithProxy(proxy.id);
  } else {
    axiosInstance = await getAxiosForUser(razerPayload.userId);
  }

  const doFetch = () => axiosInstance.get('https://gold.razer.com/api/silver/wallet', {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'x-razer-accesstoken': razerPayload.xRazerAccessToken,
      'x-razer-fpid': razerPayload.xRazerFpid || '',
      'x-razer-razerid': razerPayload.xRazerRazerid || '',
      'x-razer-language': 'en',
      'cookie': razerPayload.cookieHeader,
      'Referer': 'https://gold.razer.com/global/en/silver',
    },
    validateStatus: () => true,
  });

  let res = await doFetch();

  if (res.status === 401) {
    const newToken = await refreshAccessToken(razerPayload);
    if (newToken) res = await doFetch();
  }

  if (res.status !== 200) return { email, success: false, error: `API error (${res.status}): ${JSON.stringify(res.data)}` };

  return { email, success: true, balance: res.data };
}

async function getGoldBalanceOne(email, proxy = null) {
  const razerPayload = await RazerPayloadData.findOne({ email }).sort({ capturedAt: -1 });
  if (!razerPayload) return { email, success: false, error: 'Account not loaded' };

  let axiosInstance;
  if (proxy) {
    const { buildAxiosWithProxy } = require('../../utils/proxyAxios');
    axiosInstance = buildAxiosWithProxy(proxy.id);
  } else {
    axiosInstance = await getAxiosForUser(razerPayload.userId);
  }

  const doFetch = () => axiosInstance.get('https://gold.razer.com/api/gold/balance', {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'x-razer-accesstoken': razerPayload.xRazerAccessToken,
      'x-razer-fpid': razerPayload.xRazerFpid || '',
      'x-razer-razerid': razerPayload.xRazerRazerid || '',
      'x-razer-language': 'en',
      'cookie': razerPayload.cookieHeader,
      'Referer': 'https://gold.razer.com/global/en',
    },
    validateStatus: () => true,
  });

  let res = await doFetch();

  if (res.status === 401) {
    const newToken = await refreshAccessToken(razerPayload);
    if (newToken) res = await doFetch();
  }

  if (res.status !== 200) return { email, success: false, error: `API error (${res.status}): ${JSON.stringify(res.data)}` };

  return { email, success: true, balance: res.data };
}

async function getGoldBalances(emails, { batchSize = 50, onProgress } = {}) {
  const list = emails?.length
    ? emails
    : (await RazerPayloadData.find({}).distinct('email'));

  const start = Date.now();
  const proxies = getRotatingProxies(9);
  const results = [];

  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);

    const batchResults = await Promise.allSettled(
      batch.map((email, batchIdx) => {
        const stagger = batchIdx * 120;
        return new Promise(r => setTimeout(r, stagger))
          .then(() => getGoldBalanceOne(email, assignProxy(i + batchIdx, proxies)));
      })
    );

    batchResults.forEach((r, idx) => {
      const result = r.status === 'fulfilled'
        ? r.value
        : { email: batch[idx], success: false, error: r.reason?.message || 'Unknown error' };
      results.push(result);
      if (onProgress) onProgress(result, results.length, list.length);
    });

    if (i + batchSize < list.length) await new Promise(r => setTimeout(r, 500));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const successCount = results.filter(r => r.success).length;
  return { total: list.length, success: successCount, failed: list.length - successCount, elapsed: `${elapsed}s`, results };
}

async function getSilverBalances(emails, { batchSize = 50, onProgress } = {}) {
  const list = emails?.length
    ? emails
    : (await RazerPayloadData.find({}).distinct('email'));

  const start = Date.now();
  const proxies = getRotatingProxies(9);
  const results = [];

  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);

    const batchResults = await Promise.allSettled(
      batch.map((email, batchIdx) => {
        const stagger = batchIdx * 120;
        return new Promise(r => setTimeout(r, stagger))
          .then(() => getSilverBalanceOne(email, assignProxy(i + batchIdx, proxies)));
      })
    );

    batchResults.forEach((r, idx) => {
      const result = r.status === 'fulfilled'
        ? r.value
        : { email: batch[idx], success: false, error: r.reason?.message || 'Unknown error' };
      results.push(result);
      if (onProgress) onProgress(result, results.length, list.length);
    });

    if (i + batchSize < list.length) await new Promise(r => setTimeout(r, 500));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const successCount = results.filter(r => r.success).length;
  return { total: list.length, success: successCount, failed: list.length - successCount, elapsed: `${elapsed}s`, results };
}

function getProxiesByCountry(country) {
  const matched = PROXY_LIST.filter(p => !p.disabled && p.country.toLowerCase() === country.toLowerCase());
  return matched.length ? matched : PROXY_LIST.filter(p => !p.disabled);
}

// Cache region_id per permalink to avoid fetching it for every account
const _regionIdCache = {};

async function fetchRegionId(permalink, axiosInstance, razerPayload) {
  if (_regionIdCache[permalink]) return _regionIdCache[permalink];
  try {
    const res = await axiosInstance.get(`https://gold.razer.com/api/content/silver/catalogs/permalink/${permalink}`, {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'x-razer-language': 'en',
        'cookie': razerPayload.cookieHeader || '',
        'Referer': `https://gold.razer.com/global/en/silver/redeem/summary/${permalink}`,
      },
      validateStatus: () => true,
    });
    const regionId = res.data?.regions?.[0]?.id || null;
    if (regionId) _regionIdCache[permalink] = regionId;
    return regionId;
  } catch {
    return null;
  }
}

async function redeemSilverOne({ email, rzrotptoken, rzrotptokenTs, otp_token_enc, otp_token }, product, proxy = null) {
  const razerPayload = await RazerPayloadData.findOne({ email }).sort({ capturedAt: -1 });
  if (!razerPayload) return { email, success: false, error: 'Account not loaded' };

  let axiosInstance;
  if (proxy) {
    const { buildAxiosWithProxy } = require('../../utils/proxyAxios');
    axiosInstance = buildAxiosWithProxy(proxy.id);
  } else {
    axiosInstance = await getAxiosForUser(razerPayload.userId);
  }

  // Auto-fetch region_id if not provided (catalog list items don't include regions)
  let region_id = product.region_id;
  if (!region_id && product.permalink) {
    region_id = await fetchRegionId(product.permalink, axiosInstance, razerPayload);
  }

  const body = {
    zSilver_id: product.zSilver_id,
    region_id,
    silver_reward_id: product.silver_reward_id || product.zSilver_id,
    amount: product.amount,
    language: 'en',
    otpToken: otp_token_enc,
    pinSupplier: 'molap',
  };

  const doRedeem = () => axiosInstance.post('https://gold.razer.com/api/pincodes/redeemOS', body, {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'content-type': 'application/json',
      'pragma': 'no-cache',
      'x-razer-accesstoken': razerPayload.xRazerAccessToken,
      'x-razer-fpid': razerPayload.xRazerFpid || '',
      'x-razer-razerid': razerPayload.xRazerRazerid || '',
      'cookie': `${razerPayload.cookieHeader}; _rzrotptoken=${rzrotptoken}; _rzrotptokents=${rzrotptokenTs}; otpToken=${encodeURIComponent(otp_token)}`,
      'Referer': `https://gold.razer.com/globalzh/en/silver/redeem/summary/${product.permalink || ''}`,
    },
    validateStatus: () => true,
  });

  // Retry on timeout / network errors AND on Razer error 70610 ("transaction number is not
  // unique") — a race when concurrent redeems on the same session collide; a fresh POST gets
  // a fresh transaction number. A small jitter before each attempt de-syncs concurrent
  // requests. Do NOT retry on logical rejections like wallet-disabled (76011).
  let redeemRes;
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const jitter = 50 + Math.floor(Math.random() * 250);
    await new Promise(r => setTimeout(r, jitter));
    try {
      redeemRes = await doRedeem();
      lastErr = null;
      if (isTransactionNotUnique(redeemRes.data) && attempt < 4) {
        const backoff = 150 * attempt + Math.floor(Math.random() * 200);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      break;
    } catch (err) {
      lastErr = err;
      const retriable = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || /timeout/i.test(err.message);
      if (!retriable || attempt === 4) break;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  if (lastErr) {
    return { email, success: false, error: `Redeem request failed: ${lastErr.message}` };
  }

  // All 4 attempts collided on 70610 — surface a stable, frontend-detectable marker.
  if (isTransactionNotUnique(redeemRes.data)) {
    return { email, success: false, error: `TXN_NOT_UNIQUE_70610: transaction number not unique — failed after 4 attempts. Body: ${JSON.stringify(redeemRes.data)}` };
  }

  if (redeemRes.status !== 200) {
    return { email, success: false, error: `Redeem failed (${redeemRes.status}): ${JSON.stringify(redeemRes.data)}` };
  }

  const transactionId = redeemRes.data?.transactionNumber || redeemRes.data?.transactionId || redeemRes.data?.id;
  if (!transactionId) {
    return { email, success: false, error: `No transactionId in response: ${JSON.stringify(redeemRes.data)}` };
  }

  return { email, success: true, transactionId, axiosInstance, razerPayload };
}

async function fetchReceiptOne({ email, transactionId, axiosInstance, razerPayload }) {
  try {
    const res = await axiosInstance.get(`https://gold.razer.com/api/receipts/${transactionId}/silver`, {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'x-razer-accesstoken': razerPayload.xRazerAccessToken,
        'x-razer-fpid': razerPayload.xRazerFpid || '',
        'x-razer-razerid': razerPayload.xRazerRazerid || '',
        'cookie': razerPayload.cookieHeader,
        'Referer': `https://gold.razer.com/global/en/transaction/zSilver/${transactionId}`,
      },
      validateStatus: () => true,
    });
    if (res.status !== 200) return { email, transactionId, success: false, error: `Receipt error (${res.status}): ${JSON.stringify(res.data)}` };
    return { email, transactionId, success: true, receipt: res.data };
  } catch (err) {
    return { email, transactionId, success: false, error: `Receipt fetch failed: ${err.message}` };
  }
}

async function bulkRedeemSilver(accounts, product, { batchSize = 50, country = 'United States' } = {}) {
  const start = Date.now();

  const dedicatedProxies = PROXY_LIST.filter(p => !p.disabled && p.dedicated && p.country.toLowerCase() === country.toLowerCase());
  const sharedProxies    = getProxiesByCountry(country).filter(p => !p.dedicated);

  console.log(`[bulkRedeem] country=${country} dedicated=${dedicatedProxies.map(p => p.label).join(', ')} shared=${sharedProxies.map(p => p.label).join(', ')}`);

  // Process a chunk of accounts through a specific proxy pool in batches
  async function processChunk(chunkAccounts, proxyPool) {
    const chunkResults = [];
    for (let i = 0; i < chunkAccounts.length; i += batchSize) {
      const batch = chunkAccounts.slice(i, i + batchSize);
      const settled = await Promise.allSettled(
        batch.map((account, batchIdx) => {
          const stagger = batchIdx * 200;
          return new Promise(r => setTimeout(r, stagger))
            .then(() => redeemSilverOne(account, product, assignProxy(i + batchIdx, proxyPool)));
        })
      );
      settled.forEach((r, idx) => {
        chunkResults.push(
          r.status === 'fulfilled'
            ? r.value
            : { email: batch[idx].email, success: false, error: r.reason?.message || 'Unknown error' }
        );
      });
      if (i + batchSize < chunkAccounts.length) await new Promise(r => setTimeout(r, 1000));
    }
    return chunkResults;
  }

  let phase1 = [];

  const proxies = dedicatedProxies.length ? dedicatedProxies : PROXY_LIST.filter(p => !p.disabled);
  const perProxy = Math.ceil(accounts.length / proxies.length);
  const chunks = proxies
    .map((proxy, p) => ({ proxy: [proxy], accounts: accounts.slice(p * perProxy, (p + 1) * perProxy), label: proxy.label }))
    .filter(c => c.accounts.length > 0);

  console.log(`[bulkRedeem] Sequential chunks: ${chunks.map(c => `${c.label}×${c.accounts.length}`).join(' | ')}`);

  for (const chunk of chunks) {
    const chunkResults = await processChunk(chunk.accounts, chunk.proxy);
    phase1.push(...chunkResults);
  }

  const phase1Elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const successful = phase1.filter(r => r.success && r.transactionId);
  const failed = phase1.filter(r => !r.success);
  console.log(`[bulkRedeem] Phase 1: ${successful.length} redeemed, ${failed.length} failed in ${phase1Elapsed}s`);

  // Phase 2 — fetch all receipts in parallel (read-only, safe to fire all at once)
  const receiptSettled = await Promise.allSettled(successful.map(r => fetchReceiptOne(r)));
  const receipts = receiptSettled.map((r, idx) =>
    r.status === 'fulfilled'
      ? r.value
      : { email: successful[idx].email, transactionId: successful[idx].transactionId, success: false, error: r.reason?.message }
  );

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  return {
    total: accounts.length,
    redeemed: successful.length,
    receiptsOk: receipts.filter(r => r.success).length,
    failed: failed.length,
    elapsed: `${elapsed}s`,
    phase1Elapsed: `${phase1Elapsed}s`,
    proxiesUsed: chunks.map(c => `${c.label} ×${c.accounts.length}`),
    results: [
      // Phase 2 results — redeemed accounts with receipt or receipt-fetch error
      ...receipts.map(r => ({
        email: r.email,
        transactionId: r.transactionId,
        success: r.success,
        receipt: r.receipt || null,
        error: r.error || null,
      })),
      // Phase 1 failures — redeem itself failed
      ...failed.map(f => ({
        email: f.email,
        transactionId: null,
        success: false,
        receipt: null,
        error: f.error,
      })),
    ],
  };
}

async function checkProxyHealth() {
  const { buildAxiosWithProxy } = require('../../utils/proxyAxios');
  const TEST_URL = `https://razerid.razer.com/api/?ping=${Date.now()}`;

  const results = await Promise.allSettled(
    PROXY_LIST.filter(p => !p.disabled).map(async (proxy) => {
      const start = Date.now();
      try {
        const instance = buildAxiosWithProxy(proxy.id);
        const res = await instance.get(TEST_URL, {
          headers: {
            'accept': 'application/json',
            'accept-language': 'en-US,en;q=0.9',
            'x-razer-language': 'en',
            'Referer': 'https://gold.razer.com/',
          },
          validateStatus: () => true,
          timeout: 10000,
        });
        const elapsed = Date.now() - start;
        return {
          id: proxy.id,
          label: proxy.label,
          country: proxy.country,
          dedicated: !!proxy.dedicated,
          status: res.status,
          ok: res.status === 200,
          ms: elapsed,
        };
      } catch (err) {
        return {
          id: proxy.id,
          label: proxy.label,
          country: proxy.country,
          dedicated: !!proxy.dedicated,
          status: null,
          ok: false,
          ms: Date.now() - start,
          error: err.message,
        };
      }
    })
  );

  return results.map(r => r.status === 'fulfilled' ? r.value : r.reason);
}

module.exports = { loadAccounts, authenticateAccounts, transactAccounts, checkBalanceAccounts, getProductBalance, getSilverBalances, getGoldBalances, bulkRedeemSilver, checkProxyHealth };
