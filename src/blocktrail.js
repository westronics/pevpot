var assert = require('better-assert');
var belt = require('./belt');
var config = require('./config');
var debug = require('debug')('app:blocktrail');
var request = require('co-request');



var apiStr = 'api_key=' + config.get('BLOCKTRAIL_API_KEY');

// return a list of tx outputs that have been sent to address
function* getAddressPayments(address, fromBlock, page) {
  assert(typeof address == 'string');
  assert(Number.isInteger(fromBlock));
  assert(Number.isInteger(page));


  var url = 'https://api.blocktrail.com/v1/btc/address/' +
    address + '/transactions?page=' + page + '&limit=200&sort_dir=desc&' + apiStr;

  debug('Requesting: %s', url);

  var data = yield request(url);
  var body = JSON.parse(data.body);

  //console.log('bodycp: ', body);
  assert(body.current_page == page);
  var pages = Math.ceil(body.total / body.per_page);
  assert(Number.isInteger(pages));

  var tooMany = false; // This is set if we read past afterBlockHeight

  var payments = [];

  body.data.forEach(transaction => {
    if (transaction.block_height && transaction.block_height < fromBlock) {
      tooMany = true;
      return;
    }

    var sendingAddress = null;
    for (var input of transaction.inputs) {
      if (input.address) {
        sendingAddress = input.address;
        break;
      }
    }


    for (var output of transaction.outputs) {
      if (!output.address) {
        console.warn('Disregarding ', transaction.hash, ':', output.index, ' due to no address');
        continue;
      }
      if (output.address !== address)
        continue;

      payments.push({
        txid: transaction.hash,
        vout: output.index,
        sending_bitcoin_address: sendingAddress,
        block_height: transaction.block_height,
        amount: output.value
      });

    }

  });

  if (page < pages && !tooMany)
    payments = payments.concat(
      yield getAddressPayments(address, fromBlock, page+1)
    );

  return payments;
}


// from block is inclusive
exports.getAddressPayments = function(address, fromBlock, page) {
  return getAddressPayments(address, fromBlock || 0, page || 1);
};

exports.getBlockChainHeight = function*() {
  var url = 'https://api.blocktrail.com/v1/btc/block/latest?' + apiStr;
  debug('Requesting: %s', url);
  var req = yield request(url);
  var body = JSON.parse(req.body);
  return body.height;
}

exports.getBlockHashByHeight = function*(height) {
  var url = 'https://api.blocktrail.com/v1/btc/block/' + height + '?' + apiStr;
  debug('Requesting: %s', url);
  var req = yield request(url);

  if (req.statusCode !== 200)
    throw new Error('Could not get block height: ' + height);

  var body = JSON.parse(req.body);

  assert(body.height === height);
  return body.hash;
}

function* getUnspent(address, page) {
  assert(Number.isInteger(page));

  var url = 'https://api.blocktrail.com/v1/btc/address/' + address +
    '/unspent-outputs?limit=200&page='+ page  + '&' + apiStr;

  debug('Requesting: %s', url);

  var data = yield request(url);
  var body = JSON.parse(data.body);

  //console.log('bodycp: ', body);
  assert(body.current_page == page);

  var unspent = body.data.map(function(output) {
    return { txid: output.hash, vout: output.index, amount: output.value };
  });


  var pages = Math.ceil(body.total / body.per_page);
  assert(Number.isInteger(pages));
  if (page < pages)
    unspent = unspent.concat(
      yield getUnspent(address, page+1)
    );

  return unspent;
}

exports.getAddressUnspent = function(address) {
  return getUnspent(address, 1);
}

exports.newHook = function*(address, hookIdentifier) {

  var options = {
    uri: 'https://api.blocktrail.com/v1/BTC/webhook/' + hookIdentifier + '/events?' + apiStr,
    method: 'POST',
    json: {
      event_type: 'address-transactions',
      address: address,
      confirmations: 1
    }
  };

  debug('Requesting: %j', options);

  var data = yield request(options);

  debug('Got hook result: %j', data.body);

  if (data.statusCode !== 200 && data.body.msg !== 'Webhook event subscription already exists')
    throw new Error('Could not create hook, got: ' + JSON.stringify(data.body));
}
