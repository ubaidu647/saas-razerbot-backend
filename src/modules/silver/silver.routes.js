const express = require('express');
const router = express.Router();
const silverController = require('./silver.controller');
const { portalAuth } = require('../../middleware/portalAuth');
const razerContext = require('../../middleware/razerContext');

// Portal identity first, then resolve which Razer account the call targets.
const auth = [portalAuth, razerContext];

router.get('/catalogs', auth, silverController.getSilverCatalogs);
router.get('/catalogs/permalink/:permalink', auth, silverController.getSilverCatalogByPermalink);
router.post('/transactions', auth, silverController.redeemSilver);
router.get('/receipt/:transactionId', auth, silverController.getSilverReceipt);

module.exports = router;
