const authService = require('./auth.service');
const User = require('./user.model');
const RegisteredUser = require('./user.model');
const { loginOneAccount } = require('../../utils/razerLogin');
const { assertCanLoadAccounts } = require('../packages/limits.service');
const razerAccountService = require('../razerAccounts/razerAccount.service');


async function register(req, res, next) {
  try {
    let data = {
      email: req.body.email,
      password: req.body.password,
    }
    const result = await authService.userRegistered(data);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}



function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function login(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { email, password } = req.body;

    // Attaching a Razer account consumes a gold slot from the caller's package.
    try {
      await assertCanLoadAccounts(req.portalUser, 'gold', [email]);
    } catch (limitErr) {
      sendSSE(res, 'error', {
        success: false,
        code: limitErr.code,
        message: limitErr.message,
        details: limitErr.details,
      });
      return res.end();
    }

    const loginResult = await loginOneAccount({ email, password, serviceCode: '0060' });

    if (!loginResult.success) {
      sendSSE(res, 'error', { success: false, message: loginResult.error || 'Login failed' });
      return res.end();
    }

    sendSSE(res, 'logged_in', { message: 'Login successful, loading your account...' });

    const authResult = await authService.registerRazerBrowserLogin({
      name: email,
      email,
      password,
      ownerId: req.portalUserId,
    });

    await razerAccountService.registerLoaded(req.portalUserId, 'gold', [email]);

    await authService.saveRazerPayloadData({
      userId: authResult.user.id,
      email: authResult.user.email,
      username: authResult.user.name,
      payload: {
        cookieHeader: loginResult.cookieHeader,
        cookies: [],
        xRazerAccessToken: loginResult.xRazerAccessToken,
        xRazerFpid: loginResult.xRazerFpid || '',
        xRazerRazerid: loginResult.xRazerRazerid || '',
        razerIdAuthToken: loginResult.oauthCookieHeader || '',
        rawHeaders: {},
        referer: process.env.RAZER_GOLD_URL || 'https://gold.razer.com/global/en',
        currentUrl: process.env.RAZER_GOLD_URL || 'https://gold.razer.com/global/en',
      },
    });

    sendSSE(res, 'ready', { success: true, ...authResult });
    res.end();
  } catch (err) {
    sendSSE(res, 'error', { success: false, message: err?.message || 'Login failed' });
    res.end();
  }
}

async function homepage(req, res) {
  res.status(200).json({ message: 'Ready' });
}

async function getLogin(req, res, next) {
  try {
    const result = await authService.getLogin(req.body);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = await User.findById(req.userId);
    res.json({ user });

  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const token = req.body.refreshToken || req.cookies.refreshToken;
    if (!token) return res.status(400).json({ message: 'Refresh token required' });
    const tokens = await authService.refresh(token);
    res.json(tokens);
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const userId = req.user?.id || req.user?._id;
    if (userId) {
      await Promise.all([
        authService.revoke(userId),
        authService.clearRazerPayload(userId),
      ]);
    }
    res.json({ success: true, message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}

function redirectToRazer(req, res) {
  console.log('Redirecting to Razer for authentication');
  const redirectUri = encodeURIComponent(process.env.RAZER_CALLBACK_URL);
  const url = `https://oauth2.razer.com/authorize_openid?response_type=code&l=eng&scope=openid+profile+email&client_id=${process.env.RAZER_CLIENT_ID}&state=xyz&redirect_uri=${redirectUri}`;
  res.redirect(url);
}

async function razerCallback(req, res) {
  try {
    const { code } = req.query;
    console.log('Received Razer callback with code:', code);
    if (!code) {
      return res.status(400).json({ message: 'Authorization code is missing' });
    }

    const result = await authService.razerLoginService(code);
    // returning JSON by default; frontend may choose to redirect
    console.log('Razer login successful, user:', result.user);
    res.cookie("auth-token", result.accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none"
    });
    return res.redirect(
      `${process.env.FRONT_END_URL}/dashboard`
    );
  } catch (err) {
    console.error('Controller Error:', err.message);
    res.status(500).json({ message: 'Razer login failed' });
  }
}

function getProxies(req, res) {
  const { PROXY_LIST, DEFAULT_PROXY_ID } = require('../../utils/proxyAxios');
  const proxies = PROXY_LIST.filter((p) => !p.disabled).map(({ id, label, country }) => ({ id, label, country }));
  res.json({ success: true, proxies, defaultProxyId: DEFAULT_PROXY_ID });
}

async function setProxy(req, res, next) {
  try {
    const { proxyId } = req.body;
    const update = { proxyId: proxyId ?? null };
    await RegisteredUser.findByIdAndUpdate(req.userId, update);
    return res.json({
      success: true,
      message: proxyId ? `Proxy set to ID ${proxyId}` : 'Proxy disconnected, using default',
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  register,
  login,
  homepage,
  me,
  refresh,
  logout,
  redirectToRazer,
  razerCallback,
  setProxy,
  getProxies,
};
