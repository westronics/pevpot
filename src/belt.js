var assert = require('better-assert');
var bitcoinjs = require('bitcoinjs-lib');
var stretch = require('pevpot-stretch');

var config = require('./config');

var guaranteeKeyPair = bitcoinjs.ECPair.fromWIF(config.get('GUARANTEE_PRIV_KEY'));

var sponsorHdNode = bitcoinjs.HDNode.fromBase58(config.get('BIP32_SPONSOR_PUB_KEY'));
var forwardingHdNode = bitcoinjs.HDNode.fromBase58(config.get('BIP32_FORWARDING_PRIV_KEY'));


exports.signGuarantee = function(message) {
  return bitcoinjs.message.sign(guaranteeKeyPair, message).toString('base64');
}

exports.guaranteeAddress = function() {
  return guaranteeKeyPair.getAddress();
}

exports.deriveSponsorsAddress = function(index) {
  assert(Number.isInteger(index));
  return sponsorHdNode.derive(index).getAddress();
};

exports.deriveForwardingKeyPair = function(index) {
  assert(Number.isInteger(index));
  return forwardingHdNode.derive(index).keyPair;
}


exports.getDrawId = function(blockHeight) {
  var blocksPerDraw = 1000;
  var draw = Math.ceil(
    (blockHeight - config.get('STARTING_BLOCK')) / blocksPerDraw
  );
  return Math.max(draw, 1); // mainly for debugging
};

exports.getDrawEndByDrawId = function(draw) {
  return config.get('STARTING_BLOCK') + (1000 * draw);
}
exports.getDrawHashHeightByDrawId = function(draw) {
  return config.get('STARTING_BLOCK') + (1000 * draw) + 6;
}

exports.getDrawBlockHeightByDrawId = function(draw) {
  throw new Error('to impl');
}

exports.formatSatoshis = function (n, decimals) {
  return (n/1e8).toFixed(decimals === undefined ? 8 : decimals).replace(/\.?0+$/, '');
};

exports.formatNumber = function(n, decimals) {
  if (typeof decimals !== 'number')
    decimals = n % 1 === 0 ? 0 : 2;

  return (n).toFixed(decimals).toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1,");
};

// String -> Bool
exports.isValidBitcoinAddress = function (addr) {
  if (typeof addr !== 'string') return false;
  try {
    var version = bitcoinjs.address.fromBase58Check(addr).version;
    return version === bitcoinjs.networks.bitcoin.pubKeyHash ||
        version === bitcoinjs.networks.bitcoin.scriptHash;
  } catch(ex) {
    return false;
  }
  return true;
};

exports.isValidUuid = function(uuid) {
  var regexp = /^[a-f0-9]{8}\-[a-f0-9]{4}\-[a-f0-9]{4}\-[a-f0-9]{4}\-[a-f0-9]{12}$/;
  return regexp.test(uuid);
};

// from http://goo.gl/0ejHHW
var iso8601 = /^([\+-]?\d{4}(?!\d{2}\b))((-?)((0[1-9]|1[0-2])(\3([12]\d|0[1-9]|3[01]))?|W([0-4]\d|5[0-2])(-?[1-7])?|(00[1-9]|0[1-9]\d|[12]\d{2}|3([0-5]\d|6[1-6])))([T\s]((([01]\d|2[0-3])((:?)[0-5]\d)?|24\:?00)([\.,]\d+(?!:))?)?(\17[0-5]\d([\.,]\d+)?)?([zZ]|([\+-])([01]\d|2[0-3]):?([0-5]\d)?)?)?)?$/;

exports.isISO8601 = function(str) {
   return typeof str === 'string' && iso8601.test(str);
}

exports.stretch = function(hash) {
  // use a smaller amount of iterations on dev for speed
  var iterations = config.get('NODE_ENV') === 'development' ? 100000 : 5000000000;
  
  return new Promise(function(resolve, reject) {
    stretch(hash, iterations, function(err, data) {
      if (err)
        return reject(err);
      resolve(data);
    });
  });
}


