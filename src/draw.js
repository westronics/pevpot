var assert = require('better-assert');
var belt = require('./belt');
var blocktrail = require('./blocktrail');
var db = require('./db');

exports.process = function*(n) {
  assert(Number.isInteger(n));
  var drawHeight = belt.getDrawBlockHeightByDrawId(n);
  var drawHash = yield blocktrail.getBlockHashByHeight(drawHeight);

  // yield db.finalizeDraw(n, drawHash);
}
