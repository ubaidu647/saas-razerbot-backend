const express = require('express');
const router = express.Router();
const walletController = require('./wallet.controller');
const { portalAuth } = require('../../middleware/portalAuth');
const razerContext = require('../../middleware/razerContext');

// Portal identity first, then resolve which Razer account the call targets.
const auth = [portalAuth, razerContext];

/**
 * @route GET /api/wallet/balance
 * @desc Get user's wallet balance
 * @access Private
 */

/**
 * @route POST /api/wallet/refresh
 * @desc Refresh wallet balance from Razer API
 * @access Private
 */
router.get('/silver', auth, walletController.getSilverWallet);
router.get('/gold', auth, walletController.getGoldBalance);

/**
 * @route GET /api/wallet/summary
 * @desc Get wallet summary
 * @access Private
 */
// router.get('/summary', authenticateToken, walletController.getWalletSummary);

module.exports = router;
