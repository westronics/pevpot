var assert = require('better-assert');
var belt = require('./belt');
var draw = require('./draw');
var db = require('./db');
var blocktrail = require('./blocktrail');
var lotteryPayments = require('./lottery_payments');


exports.process = function*() {
  var currentBlockHeight = yield blocktrail.getBlockChainHeight();
  yield lotteryPayments.process(currentBlockHeight);

  var lastDraw = yield db.getLastFinalizedDrawId();
  var currentDraw = belt.getDrawId(currentBlockHeight+1);

  for (var n = lastDraw+1; n < currentDraw; ++n) {
    // ...we need to do something
    yield draw.process(n);
  }
}
