var assert = require('better-assert');
var belt = require('./belt');
var blocktrail = require('./blocktrail');
var db = require('./db');

// returns if it processed it or not
exports.process = function*(paymentAddress) {
  assert(belt.isValidBitcoinAddress(paymentAddress));

  var sponsor = yield db.getSponsorByBitcoinAddress(paymentAddress);
  if (!sponsor)
    return false;

  var blockHeight = yield blocktrail.getBlockChainHeight();

  console.log('Got sponsor: ', sponsor);

  var scanFrom = Math.max(sponsor.scanned_height-6, 0);
  assert(Number.isInteger(scanFrom));

  var payments = yield blocktrail.getAddressPayments(paymentAddress, scanFrom);

  yield db.updateSponsorPayments(sponsor.id, payments, scanFrom, blockHeight);

  return true;
}
