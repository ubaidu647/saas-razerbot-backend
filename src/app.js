const express = require('express');
const cookieParser = require('cookie-parser');
const authRouter = require('./modules/auth/auth.routes');
const gamesRouter = require('./modules/games/games.routes');
const walletRouter = require('./modules/wallet/wallet.routes');
const transactionsRouter = require('./modules/transactions/transactions.routes');
const silverRouter = require('./modules/silver/silver.routes');
const multipleSilverLoginRouter = require('./modules/multipleSilverLogin/multipleSilverLogin.routes');
const multiAccountHistoryRouter = require('./modules/multiAccountHistory/multiAccountHistory.routes');
const proxyRouter = require('./modules/proxy/proxy.routes');
const adminRouter = require('./modules/admin/admin.routes');
const portalRouter = require('./modules/portal/portal.routes');
const errorHandler = require('./middleware/errorHandler');
const cors = require("cors");

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'x-razer-account'],
}));
app.use(express.json());
app.use(cookieParser());

// SaaS surfaces: super admin console and the customer portal.
app.use('/api/admin', adminRouter);
app.use('/api/portal', portalRouter);

app.use('/api/auth', authRouter);
app.use('/api/games', gamesRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/silver', silverRouter);
app.use('/api/multiple-silver-login', multipleSilverLoginRouter);
app.use('/api/multiple-silver-login', multiAccountHistoryRouter);
app.use('/api/proxies', proxyRouter);

app.use((req, res, next) => {
  res.status(404).json({ message: 'Not Found' });
});


app.use(errorHandler);

module.exports = app;
