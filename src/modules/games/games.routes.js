const express = require('express');
const router = express.Router();
const gamesController = require('./games.controller');
const { portalAuth } = require('../../middleware/portalAuth');
const razerContext = require('../../middleware/razerContext');

// Portal identity first, then resolve which Razer account the call targets.
const auth = [portalAuth, razerContext];

router.get('/list', auth, gamesController.getGamesList);
router.get('/search', auth, gamesController.searchGames);
router.post('/prices', auth, gamesController.getProductPrices);
router.get('/:regionId/:permalink', auth, gamesController.getGameDetail);

module.exports = router;
