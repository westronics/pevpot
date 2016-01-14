var assert = require('better-assert');
var config = require('./config');
var blocktrail = require('./blocktrail');
var db = require('./db');


exports.process = function*(blockHeight) {
  assert(!blockHeight || Number.isInteger(blockHeight));

  if (!blockHeight)
    blockHeight = yield blocktrail.getBlockChainHeight();

  var scannedHeight = (yield db.getInfo()).lottery_scanned_height;

  var scanFrom = Math.max(scannedHeight-6, 0);
  assert(Number.isInteger(scanFrom));

  var payments = yield blocktrail.getAddressPayments(config.get('LOTTERY_ADDRESS'), scanFrom);

  yield db.updateLotteryPayments(payments, scanFrom, blockHeight);
}
