var assert = require('better-assert');

var data = new Map([
    ['NODE_ENV', process.env.NODE_ENV || 'development'],
    ['BIP32_SPONSOR_PUB_KEY', process.env.BIP32_SPONSOR_PUB_KEY],
    ['BIP32_FORWARDING_PRIV_KEY', process.env.BIP32_FORWARDING_PRIV_KEY],
    ['BLOCKTRAIL_API_KEY', process.env.BLOCKTRAIL_API_KEY],
    ['DATABASE_URL', process.env.DATABASE_URL || 'postgres://localhost/pevpot'],
    ['TX_FEE_PER_KB', parseInt(process.env.FEE_PER_KB) || 15000],
    ['GUARANTEE_PRIV_KEY', process.env.PRIV_KEY],
    ['LOTTERY_ADDRESS', process.env.LOTTERY_ADDRESS],
    ['STARTING_BLOCK', parseInt(process.env.STARTING_BLOCK) || 383000],
    ['DUST_THRESHOLD', parseInt(process.env.DUST_THRESHOLD) || 10000],
    ['PORT', parseInt(process.env.PORT) || 3000],
]);

exports.get = function(k) {
  assert(typeof k === 'string');
  var t = data.get(k);
  if (t === undefined)
    throw new Error('Could not find configuration option: ' + k);
  return t;
};
