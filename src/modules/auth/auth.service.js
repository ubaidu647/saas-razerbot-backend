const User = require('./user.model');
const RegisteredUser = require('./user.model');
const RazerPayloadData = require('./razerPayloadData.model');

const DEFAULT_RAZER_GOLD_URL = process.env.RAZER_GOLD_URL || 'https://gold.razer.com/pk/en';
const { hashPassword, compare } = require('../../utils/hash');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../../utils/jwt');
const axios = require('axios');
const qs = require('qs');
const mongoose = require('mongoose');
const crypto = require('crypto');
const walletService = require('../wallet/wallet.service');

function buildAuthResponse(user, accessToken, refreshToken) {
  return {
    user: {
      id: user._id,
      name: user.name || user.first_name || '',
      email: user.email,
    },
    accessToken,
    refreshToken,
  };
}

/**
 * Local registration (email/password)
 */
async function register({ name, email, password }) {
  const existing = await User.findOne({ email });
  if (existing) throw { status: 400, message: 'Email already in use' };
  const hashed = await hashPassword(password);
  const user = await User.create({ name, email, password: hashed, provider: 'local' });
  const accessToken = signAccessToken(user._id);
  const refreshToken = signRefreshToken(user._id);
  user.refreshToken = refreshToken;
  await user.save();
  return buildAuthResponse(user, accessToken, refreshToken);
}

async function userRegistered({ email, password }) {
  const existing = await RegisteredUser.findOne({ email });
  if (existing) throw { status: 400, message: 'Email already in use' };
  const hashed = await hashPassword(password);
  const registeredUser = await RegisteredUser.create({email, password: hashed, provider: 'local' });
  
  await registeredUser.save();
  return registeredUser;
}

async function login({ email, password }) {
  const user = await User.findOne({ email });
  if (!user) throw { status: 400, message: 'Invalid credentials' };
  const isMatch = await compare(password, user.password);
  if (!isMatch) throw { status: 400, message: 'Invalid credentials' };

  const accessToken = signAccessToken(user._id);
  const refreshToken = signRefreshToken(user._id);
  user.refreshToken = refreshToken;
  await user.save();

  return buildAuthResponse(user, accessToken, refreshToken);
}

async function registerRazerBrowserLogin({ name, email, password, ownerId = null }) {
  let user = await User.findOne({ email });
  const hashedPassword = await hashPassword(password);

  if (!user) {
    user = await User.create({
      name,
      email,
      password: hashedPassword,
      provider: 'razer',
      ownerId,
    });
  } else {
    user.name = name;
    user.password = hashedPassword;
    user.provider = user.provider || 'razer';
    // Claim the record for the portal user driving this login. Pre-SaaS rows
    // have no owner, so the first tenant to load them takes ownership.
    if (ownerId) user.ownerId = ownerId;
  }

  const accessToken = signAccessToken(user._id);
  const refreshToken = signRefreshToken(user._id);
  user.refreshToken = refreshToken;
  await user.save();

  return buildAuthResponse(user, accessToken, refreshToken);
}

async function saveRazerPayloadData({ userId, email, username, payload }) {
  const doc = await RazerPayloadData.findOneAndUpdate(
    { userId },
    {
      $set: {
        email,
        username: username || '',
        referer: payload?.referer || '',
        currentUrl: payload?.currentUrl || '',
        cookieHeader: payload?.cookieHeader || '',
        cookies: payload?.cookies || [],
        xRazerAccessToken: payload?.xRazerAccessToken || '',
        xRazerFpid: payload?.xRazerFpid || '',
        xRazerRazerid: payload?.xRazerRazerid || '',
        razerIdAuthToken: payload?.razerIdAuthToken || '',
        rawHeaders: payload?.rawHeaders || {},
        capturedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return doc;
}

/**
 * Third‑party Razer OAuth flow
 */
async function razerLoginService(code) {
  try {
    // 1. Exchange code for token
    const tokenRes = await axios.post(
      'https://oauth2.razer.com/token',
      qs.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: process.env.RAZER_CLIENT_ID,
        client_secret: process.env.RAZER_SECRET,
        redirect_uri: process.env.RAZER_CALLBACK_URL,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    // 2. Fetch user profile
    const userRes = await axios.get('https://oauth2.razer.com/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const razerUser = userRes.data;
    // 3. Persist or look up user
    let user = await User.findOne({ email: razerUser.email });
    let accessToken, refreshToken;
    if (!user) {
      const userId = new mongoose.Types.ObjectId();
      accessToken = signAccessToken(userId);
      refreshToken = signRefreshToken(userId);
      refreshToken = refreshToken;
      user = await User.create({
        name: razerUser.first_name || razerUser.email,
        email: razerUser.email,
        first_name: razerUser.first_name,
        last_name: razerUser.last_name,
        email_verified: razerUser.email_verified,
        refresh_token_razer: refresh_token,
        accessToken_razer: access_token,
        refreshToken: refreshToken,
        accessToken: accessToken,
        open_id: razerUser.open_id,
        provider: 'razer',
      });
    }
    if (user) {
      accessToken = signAccessToken(user._id);
      refreshToken = signRefreshToken(user._id);
      let userUpdate = await User.findOneAndUpdate(
        { email: razerUser.email },
        {
          $set: {
            accessToken: accessToken,
            refreshToken: refreshToken,
            accessToken_razer: access_token,
            refresh_token_razer: refresh_token
          }
        },
        { new: true }
      );
    }

    // 4. Update wallet balance from Razer
    const getBalance = async () => {
      try {
        const res = await axios.get(
          "https://gold.razer.com/api/gold/balance",
          {
            headers: {
              "accept": "application/json",
              "accept-language": "en-US,en;q=0.9",
              "x-razer-accesstoken": `Bearer ${access_token}`,
              "x-razer-fpid": "razerid.razer.com",
              "x-razer-razerid": razerUser.open_id,
              "cookie": "",
              "referer": DEFAULT_RAZER_GOLD_URL,

            }
          }
        )
        return res.data;
      } catch (err) {
        console.error('Balance fetch error:', err);
      }
    }

    let balance = await getBalance();
    // 5. Return tokens + basic user info + wallet
    return {
      user: { id: user._id, name: user.name || user.first_name || '', email: user.email },
      access_token,
      accessToken,
      refreshToken,
      refresh_token,
      expires_in,
    };
  } catch (err) {
    console.error('Service Error:', err.response?.data || err.message);
    throw new Error('Razer service failed');
  }
}

// async function getWalletBalance(userEmail) {
//   const url = "https://sandbox-api.mol.com/reload/directreloadinitiation";

//   const applicationCode = "YOUR_APP_CODE";
//   const secretKey = "YOUR_SECRET_KEY";
//   const sku = "YOUR_SKU"; // VERY IMPORTANT
//   const version = "v1";
//   const referenceId = "INV_" + Date.now();
//   const customValue = ""; // keep empty if not needed

//   // 🔐 Create signature string
//   const rawString =
//     applicationCode +
//     userEmail +
//     sku +
//     referenceId +
//     customValue +
//     version +
//     secretKey;

//   const signature = crypto
//     .createHash("md5")
//     .update(rawString)
//     .digest("hex");

//   try {
//     const response = await axios.post(
//       url,
//       new URLSearchParams({
//         applicationCode,
//         version,
//         referenceId,
//         username: userEmail,
//         sku,
//         customValue,
//         signature,
//       }),
//       {
//         headers: {
//           "Content-Type": "application/x-www-form-urlencoded",
//         },
//       }
//     );

//     const data = response.data;

//     console.log("Full Response:", data);

//     if (data.initiationResultCode === "00") {
//       console.log("✅ Wallet Balance:", data.walletBalance);
//       return data.walletBalance;
//     } else {
//       console.log("❌ Failed:", data.initiationResultCode);
//       return null;
//     }
//   } catch (err) {
//     console.error("API Error:", err.response?.data || err.message);
//   }
// }


async function getRazerWalletBalance(userAccessToken) {
  const API_ID = process.env.RAZER_CLIENT_ID; // Your Razer API ID
  const API_KEY = process.env.RAZER_SECRET; // Your Razer API Key (shared secret)

  // 1. Define Request Metadata
  const httpVerb = 'GET';
  const relativeUri = 'v1/wallet/balance'; // Verify exact endpoint for your region
  const baseUrl = 'https://sandbox.api.razer.com/';

  // 2. Generate the HMAC-SHA256 Signature
  // Format: hex(hmac-sha256(verb + uri, api_key))
  const signatureHex = crypto
    .createHmac('sha256', API_KEY)
    .update(httpVerb + relativeUri)
    .digest('hex');

  // 3. Construct the X-Razer-Signature Header
  // Format: base64(api-id):base64(signatureHex)
  const base64Id = Buffer.from(API_ID).toString('base64');
  const base64Sig = Buffer.from(signatureHex).toString('base64');
  const xRazerSignature = `${base64Id}:${base64Sig}`;

  try {
    const response = await axios({
      method: httpVerb,
      url: baseUrl + relativeUri,
      headers: {
        'Authorization': `Bearer ${userAccessToken}`,
        'X-Razer-Signature': xRazerSignature,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching Razer balance:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Refresh access token using stored refresh token
 */
async function refresh(refreshToken) {
  try {
    const payload = verifyRefreshToken(refreshToken);
    const user = await User.findById(payload.sub);
    if (!user || user.refreshToken !== refreshToken) throw { status: 401, message: 'Invalid token' };
    const accessToken = signAccessToken(user._id);
    const newRefresh = signRefreshToken(user._id);
    user.refreshToken = newRefresh;
    await user.save();
    return { accessToken, refreshToken: newRefresh };
  } catch (err) {
    throw { status: 401, message: 'Invalid token' };
  }
}

/**
 * Revoke refresh token (logout)
 */
async function revoke(userId) {
  const user = await User.findById(userId);
  if (!user) return;
  user.refreshToken = null;
  await user.save();
}

/**
 * Clear all stored Razer cookies and tokens for a user
 */
async function clearRazerPayload(userId) {
  await RazerPayloadData.findOneAndUpdate(
    { userId },
    {
      $set: {
        cookieHeader: '',
        cookies: [],
        xRazerAccessToken: '',
        xRazerFpid: '',
        xRazerRazerid: '',
        razerIdAuthToken: '',
        rawHeaders: {},
      },
    }
  );
}

module.exports = { register,userRegistered, login, registerRazerBrowserLogin, saveRazerPayloadData, razerLoginService, refresh, revoke, clearRazerPayload };
