const express = require('express');
const { portalAuth } = require('../../middleware/portalAuth');
const razerContext = require('../../middleware/razerContext');

// Portal identity first, then resolve which Razer account the call targets.
const auth = [portalAuth, razerContext];
const transactionsController = require('./transactions.controller');

const router = express.Router();

router.post('/batches', auth, transactionsController.startBatch);
router.post('/batches/multi', auth, transactionsController.startMultiBatch);
router.get('/batches/:jobId', auth, transactionsController.getBatchStatus);
router.post('/batches/:jobId/pause', auth, transactionsController.pauseBatch);
router.post('/batches/:jobId/resume', auth, transactionsController.resumeBatch);
router.post('/batches/:jobId/stop', auth, transactionsController.stopBatch);
router.post('/batches/:jobId/accounts/:email/pause', auth, transactionsController.pauseAccountInBatch);
router.post('/batches/:jobId/accounts/:email/resume', auth, transactionsController.resumeAccountInBatch);
router.post('/batches/:jobId/accounts/:email/stop', auth, transactionsController.stopAccountInBatch);
router.post('/otp/generate', auth, transactionsController.generateOTP);
router.get('/history', auth, transactionsController.getTransactionHistory);
router.post('/pin-history', auth, transactionsController.getPinHistory);
router.get('/progress', auth, transactionsController.getProgress);
router.delete('/progress', auth, transactionsController.deleteProgress);
router.get('/multi-progress', auth, transactionsController.getMultiProgress);
router.delete('/multi-progress', auth, transactionsController.deleteMultiProgress);
module.exports = router;
