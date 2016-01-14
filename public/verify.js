// and https://github.com/digitalbazaar/forge for pbkdf2
// and https://github.com/peterolson/BigInteger.js for mod

(function(exports) {

  // some constants
  var DUST_THRESHOLD = 10000;
  var LOTTERY_ADDRESS = '1EA1WP8pcZY4XVLzXEB7CdQKQtysYdV2N2';

  // calls callback with (err, stretchedBlockHashInHex)
  exports.stretchBlockHash = function(blockHash, iterations, callback) {

    forge.pbkdf2(blockHash, 'pevpot', iterations, 32, 'sha256',
      function(err, bs) {
        if (err)
          return callback(err);

        var bb = new forge.util.ByteBuffer(bs);
        callback(null, bb.toHex());
      });
  }


  function get(url, callback) {
    var req = new XMLHttpRequest();
    console.log('Running get: ', url);
    req.open('GET', url);
    req.addEventListener('load', function() {
      callback(null, JSON.parse(this.responseText));
    });
    req.addEventListener('error', function(err) {
      callback(err);
    })
    req.send();
  }


  exports.getBlockHash = function(height, callback) {
    var url = 'https://api.blockcypher.com/v1/btc/main/blocks/' + encodeURIComponent(height) + '?txstart=1&limit=1';
    //var url = 'https://blockchain.info/block/' + height +'?format=json&cors=true'
    get(url, function(err, blockinfo) {
      if (err)
        return callback(err);
      callback(null, blockinfo.hash);
    });
  }

  // blocks are inclusive, from must be higher than to (we go in DESC order)
  // blockcyher has api problems, so lets not use this for now...
  //
  // function getLotteryTransactionsBC(from, to, callback) {
  //   var url = 'https://api.blockcypher.com/v1/btc/main/addrs/' + LOTTERY_ADDRESS + '/full?before=' + (from+1);
  //
  //   var payments = [];
  //
  //   get(url, function(err, data) {
  //     if (err)
  //       return callback(err);
  //
  //
  //     data.txs.forEach(function(transaction) {
  //       console.assert(transaction.block_height <= from);
  //       if (transaction.block_height < to)
  //         return;
  //
  //       transaction.outputs.forEach(function(output, index) {
  //
  //         if (output.addresses.length !== 1 || output.addresses[0] !== LOTTERY_ADDRESS)
  //           return;
  //
  //         payments.push({
  //           txid: transaction.hash,
  //           vout: index,
  //           amount: output.value
  //         });
  //       });
  //     });
  //
  //     console.log('After: ' + data.txs.length + ' added ' + payments.length);
  //
  //     if (data.txs.length === 0) // no transactions left..
  //       return callback(null, payments);
  //
  //     var lastTx = data.txs[data.txs.length-1];
  //     if (lastTx.block_height <= to)
  //       return callback(null, payments);
  //
  //     // else continue...
  //     getLotteryTransactionsBC(lastTx.block_height-1, to, function(err, newPayments) {
  //       if (err)
  //         return callback(err);
  //
  //       console.log('Adding an extra: ', newPayments.length);
  //
  //       callback(null, payments.concat(newPayments));
  //     });
  //   });
  //
  // }


  // use insight.bit
  // from and to are inclusive, from must be higher than to (we go in DESC order)
  function getLotteryTransactions(from, to, callback) {
    var payments = {};   // payments is an object, keys are txid's. We use this to dedupe

    // page starts at 0
    function doWork(page, callback) {
      var limit = 10;

      var url = 'https://crossorigin.me/' +
        'https://blockchain.info/address/' + LOTTERY_ADDRESS + '?format=json&limit=' + limit +
        '&offset=' + page*limit;


      get(url, function(err, data) {
        if (err)
          return callback(err);

        var done = false;


        data.txs.forEach(function(transaction) {
          
          var height = transaction.block_height;
          if (!height || height > from) return;
          if (height < to) {
            done = true;
            return;
          }

          transaction.out.forEach(function(output) {

            if (output.addr !== LOTTERY_ADDRESS)
                return;

            if (!payments[transaction.hash]) {
              payments[transaction.hash] = {
                height: height,
                txid: transaction.hash,
                amount: 0
              };
            }

            payments[transaction.hash].amount += output.value;

          });
        });

        if (done || data.txs.length === 0) // no transactions left..
          return callback(null);

        // else continue...
        doWork(page+1, callback);
      });
    }


    doWork(0, function(err) {
      if (err)
        return callback(err);

      var txs = Object.keys(payments).map(function(txid) {
        return payments[txid];
      });

      callback(null, txs);

    });


  }

  exports.findDraw = function(stretchedHash, transactions) {

    var tickets = 0;

    transactions.sort(function(t1, t2) {
      return t1.txid.localeCompare(t2.txid);
    });

    transactions.forEach(function(transaction) {
      if (transaction.amount >= DUST_THRESHOLD)
        tickets += transaction.amount;
    });

    var winningTicket = bigInt(stretchedHash, 16).mod(tickets).toJSNumber();
    var winningTx = null;

    var count = 0;
    transactions.forEach(function(transaction) {
      if (transaction.amount < DUST_THRESHOLD)
        return;

      if (winningTicket >= count && winningTicket < count+transaction.amount)
        winningTx = transaction;

      count += transaction.amount;
    });

    return {
      tickets: tickets,
      winningTicket: winningTicket,
      winningTx: winningTx
    };
  }

  exports.getLotteryTransactions = getLotteryTransactions;



})(this);
