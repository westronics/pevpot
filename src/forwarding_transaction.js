var assert = require('better-assert');
var belt = require('./belt');
var bitcoinjs = require('bitcoinjs-lib');
var blocktrail = require('./blocktrail');
var co = require('co');
var config = require('./config');
var debug = require('debug')('app:forwarding-transaction');
var db = require('./db');
var request = require('co-request');


function rawCreateForwardingTransaction(keyPair, inputs, destination, fee) {
  var total = 0

  var tx = new bitcoinjs.TransactionBuilder();

  for (var inp of inputs) {
    total += inp.amount;
    tx.addInput(inp.txid, inp.vout);
  }

  if (total-fee < config.get('DUST_THRESHOLD'))
    return null;

  tx.addOutput(destination, total-fee);

  for (var i = 0; i < inputs.length; ++i) {
    tx.sign(i, keyPair);
  }

  return tx.build().toHex();
}



function* pushBlockr(transaction) {
  var options = {
    uri: 'https://btc.blockr.io/api/v1/tx/push',
    method: 'POST',
    json: {
      hex: transaction
    }
  };

  var response = yield request(options);
  debug('blockr body: ', response.body);
  return response.statusCode == 200;
}

function* pushBlockchain(transaction) {
  var options = {
    uri: 'https://blockchain.info/pushtx',
    method: 'POST',
    form: {
      tx: transaction
    }
  };

  var response = yield request(options);
  debug('blockchain.info body: ', response.body);
  return response.statusCode == 200;
}


function push(transaction) {
  return Promise.all([
    co(pushBlockr(transaction)),
    co(pushBlockchain(transaction))
  ]).then(function(results) {
    debug('blockr worked: %s and blockchain.info worked %s', results[0], results[1]);

    return results[0] || results[1];
  });
};


// returns true if there was something to push
// false if there was nothing to push, and throws if there was an error
function* createAndPush(index) {
  var destination = config.get('LOTTERY_ADDRESS');
  var keyPair = belt.deriveForwardingKeyPair(index);
  var unspent = yield blocktrail.getAddressUnspent(keyPair.getAddress().toString());

  debug('Creating a transaction to %s using inputs %j', destination, unspent);
  var testTransaction = rawCreateForwardingTransaction(keyPair, unspent, destination, 0);
  debug('Got a transaction: %s', testTransaction);

  if (!testTransaction)
    return false;

  var bytes = testTransaction.length / 2;
  var kib = bytes / 1000;

  var fee = Math.ceil(config.get('TX_FEE_PER_KB') * kib);

  var transaction = rawCreateForwardingTransaction(keyPair, unspent, destination, fee);
  debug('Got transaction now: %s', transaction);

  if (!transaction)
    return false;

  if (!(yield push(transaction)))
    throw new Error("Could not push tx " + transaction);

  return true;
}

exports.createPushAndUpdateDbNextSend = function*(forwardingIndex) {
  var didSomething = yield createAndPush(forwardingIndex);
  yield db.updateForwardingNextSend(forwardingIndex, didSomething);
  return didSomething;
}
