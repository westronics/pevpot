"use strict";
var assert = require('better-assert');
var belt = require('./belt');
var bignum = require('bignum');
var blocktrail = require('./blocktrail');
var config = require('./config');
var debug = require('debug')('app:db');
var util = require('util');
var pg = require('co-pg')(require('pg'));

var bitcoinjs = require('bitcoinjs-lib');


// parse int8 as an integer
// TODO: Handle numbers past parseInt range
pg.types.setTypeParser(20, val => val === null ? null : parseInt(val));
// parse numeric
pg.types.setTypeParser(1700, val => val === null ? null : parseFloat(val));

if (config.get('NODE_ENV') === 'development') {
  console.log('Disabling pooling for development.');
  pg.defaults.poolSize = 0;
}

pg.on('error', function(err) {
  console.error('POSTGRES EMITTED AN ERROR', err);
});

function *query(sql, params) {
  var connResult = yield pg.connectPromise(config.get('DATABASE_URL'));
  var client = connResult[0];
  var done = connResult[1];
  try {
    return yield client.queryPromise(sql, params);
  } finally {
    done();  // Release client back to pool, even if there was a query error
  }
}

exports.query = query;

function *queryOne(sql, params) {
  var result = yield query(sql, params);
  assert(result.rows.length <= 1);
  return result.rows[0];
}

function *queryMany(sql, params) {
  var result = yield query(sql, params);
  return result.rows;
}

// Runner takes a client,
// and never BEGIN or COMMIT a transaction.
function* withTransaction(runner) {

  return yield withClient(function*(client) {
    try {
      yield client.queryPromise('BEGIN');
      var r = yield runner(client);
      yield client.queryPromise('COMMIT');
      return r;
    } catch (ex) {
      try {
        yield client.queryPromise('ROLLBACK');
      } catch(ex) {
        ex.removeFromPool = true;
        throw ex;
      }
      throw ex;
    }

  });

}

// Runner will be recalled if deadlocked
function* withClient(runner) {
  var connResult = yield pg.connectPromise(config.get('DATABASE_URL'));
  var client = connResult[0];
  var done = connResult[1];

  var r;
  try {
    r = yield runner(client);
  } catch (ex) {
    if (ex.removeFromPool) {
      done(new Error('Removing connection from pool'));
      throw ex;
    } else if (ex.code === '40P01') { // Deadlock
      done();
      return yield withClient(runner);
    } else {
      done();
      throw ex;
    }
  }

  done();
  return r;
}

exports.getNewestSponsors = function*() {
  // get everything but the pic..
  var sql = `SELECT id, name, url, bitcoin_address, scanned_height, created
  FROM sponsors
  ORDER BY id DESC
  LIMIT 10`;
  return yield queryMany(sql);
}

exports.getBiggestAllTimeSponsors = function*() {
  var sql = `SELECT SUM(sponsor_payments.amount) amount,
     sponsors.id,
     sponsors.name
    FROM sponsors
    JOIN sponsor_payments ON sponsor_payments.sponsor_id = sponsors.id
    WHERE sponsor_payments.dust = false
    GROUP BY sponsors.id
    ORDER BY 1 DESC
    LIMIT 10
    `;
  return yield queryMany(sql);
}


exports.getNextDrawSponsors = function*() {
  var getSql = `SELECT lottery_scanned_height FROM info`;

  var r = yield queryOne(getSql);

  var nextDraw = belt.getDrawId(r.lottery_scanned_height+1)+1;


  var sql = `SELECT SUM(sponsor_payments.amount) amount,
     sponsors.id,
     sponsors.name
    FROM sponsors
    JOIN sponsor_payments ON sponsor_payments.sponsor_id = sponsors.id
    WHERE sponsor_payments.dust = false
    AND sponsor_payments.draw_id = $1
    GROUP BY sponsors.id
    ORDER BY 1 DESC
    LIMIT 50
    `;
  return yield queryMany(sql, [nextDraw]);
}


exports.createSponsor = function*(name, url, pic) {
  assert(typeof name === 'string');
  assert(typeof url === 'string');
  assert(Buffer.isBuffer(pic));

  var id = (yield queryOne("SELECT nextval('sponsors_id_seq') as next")).next;
  var bitcoinAddress = belt.deriveSponsorsAddress(id);
  assert(typeof bitcoinAddress === 'string');


  var hookIdentifier = config.get('NODE_ENV') === 'development' ? 'dev-sponsor-tx' : 'sponsor-tx';

  yield blocktrail.newHook(bitcoinAddress, hookIdentifier);

  var sql = "INSERT INTO sponsors(id, name, url, bitcoin_address, pic) VALUES($1, $2, $3, $4, $5)";

  yield query(sql, [id, name, url, bitcoinAddress, pic]);

  return id;
}


exports.getSponsorPic = function*(id) {
  var r = yield queryOne("SELECT pic FROM sponsors WHERE id = $1", [id]);
  return r ? r.pic : r;
}

exports.getSponsorById = function*(id) {
  // get everything but the pic..
  var sql = "SELECT id, name, url, bitcoin_address, scanned_height, created FROM sponsors WHERE id = $1";
  return yield queryOne(sql, [id]);
}

exports.getSponsorByBitcoinAddress = function*(bitcoinAddress) {
  assert(belt.isValidBitcoinAddress(bitcoinAddress));
  var sql = 'SELECT id, name, url, bitcoin_address, scanned_height, created FROM sponsors WHERE bitcoin_address = $1';
  return yield queryOne(sql, [bitcoinAddress]);
}

exports.getSponsorsByDrawId = function*(drawId, limit) {
  assert(Number.isInteger(drawId));
  assert(Number.isInteger(limit));


  var sql = `SELECT sponsors.id, sponsors.name, sponsors.url, SUM(sponsor_payments.amount) AS amount
  FROM sponsors
  JOIN sponsor_payments ON sponsor_payments.sponsor_id = sponsors.id
  WHERE sponsor_payments.draw_id = $1
  AND sponsor_payments.dust = false
  GROUP BY sponsors.id
  ORDER BY SUM(sponsor_payments.amount) DESC, id
  LIMIT $2
  `;

  return yield queryMany(sql, [drawId, limit]);
}

exports.updateSponsorPayments = function*(sponsorId, payments, from, scannedHeight) {
  return yield withTransaction(function*(client) {
    // first the update to lock
    var updateSql = 'UPDATE sponsors SET scanned_height = $1 WHERE id = $2';
    var r = yield client.queryPromise(updateSql, [scannedHeight, sponsorId]);
    assert(r.rowCount === 1);

    var deleteSql = 'DELETE FROM sponsor_payments WHERE sponsor_id = $1 AND (block_height IS NULL OR block_height >= $2)';
    yield client.queryPromise(deleteSql, [sponsorId, from]);

    var insertSql = `INSERT INTO sponsor_payments(sponsor_id, txid, vout, block_height, amount, dust, draw_id)
    VALUES($1, $2, $3, $4, $5, $6, $7)`;

    for (var payment of payments) {
      var draw = belt.getDrawId(payment.block_height || scannedHeight)+1;
      var isDust = payment.amount < config.get('DUST_THRESHOLD');
      r = yield client.queryPromise(insertSql,
        [sponsorId, payment.txid, payment.vout, payment.block_height, payment.amount, isDust, draw]);
      assert(r.rowCount === 1);
    }

  });
}

exports.updateLotteryPayments = function*(payments, from, scannedHeight) {
  return yield withTransaction(function*(client) {
    // first the update to lock
    var updateSql = 'UPDATE info SET lottery_scanned_height = $1';
    var r = yield client.queryPromise(updateSql, [scannedHeight]);
    assert(r.rowCount === 1);

    var deleteSql = 'DELETE FROM lottery_payments WHERE (block_height IS NULL OR block_height >= $1)';
    yield client.queryPromise(deleteSql, [from]);

    var insertSql = `INSERT INTO lottery_payments(draw_id, txid, vout, amount, dust, sending_bitcoin_address, block_height)
    VALUES($1, $2, $3, $4, $5, $6, $7)`;

    for (var payment of payments) {
      var drawId = belt.getDrawId(payment.block_height || scannedHeight+1);

      var isDust = payment.amount < config.get('DUST_THRESHOLD');

      r = yield client.queryPromise(insertSql,
        [drawId, payment.txid, payment.vout, payment.amount, isDust, payment.sending_bitcoin_address, payment.block_height]);
      assert(r.rowCount === 1);
    }

  });
}
exports.getLatestTickets = function*() {
  var sql = `SELECT * FROM lottery_payments
y    WHERE dust=false
    ORDER BY block_height DESC NULLS FIRST, created DESC
    LIMIT 5`;
  return yield queryMany(sql);
}

exports.getLotteryPaymentsByDrawId = function*(drawId) {
  var sql = `SELECT * FROM lottery_payments
    WHERE draw_id=$1 AND dust=false
    ORDER BY txid, vout
    LIMIT 3000`;
  return yield queryMany(sql, [drawId]);
}

exports.getSponsorPaymentsByDrawId = function*(drawId) {
  var sql = `SELECT * FROM sponsor_payments
    WHERE draw_id=$1 AND dust=false
    ORDER BY block_height DESC NULLS FIRST, id
    LIMIT 2500
  `
  return yield queryMany(sql, [drawId]);
}

exports.getDrawsSponsorPaymentsBySponsor = function*(sponsorId) {
  assert(Number.isInteger(sponsorId));

  var sql = 'SELECT * FROM sponsor_payments WHERE sponsor_id = $1 ORDER BY block_height DESC NULLS FIRST LIMIT 10000';

  var draws = new Map();

  var results = yield queryMany(sql, [sponsorId]);

  for (var result of results) {
    if (!draws.has(result.draw_id))
      draws.set(result.draw_id, { totalRecieved: 0, sponsorPayments: [] });

    var draw = draws.get(result.draw_id);
    if (!result.dust && result.block_height)
      draw.totalRecieved += result.amount;

    draw.sponsorPayments.push(result);
  }

  return draws;

}

exports.getRegisteredAddressById = function*(id) {
  var sql = `SELECT * FROM registered_addresses WHERE id = $1`;
  return yield queryOne(sql, [id]);
}

exports.getRegisteredAddressByForwardingBitcoinAddress = function*(address) {
  assert(typeof address === 'string');
  var sql = `SELECT * FROM registered_addresses WHERE bitcoin_address = $1 AND forwarding_index IS NOT NULL`;
  return yield queryOne(sql, [address]);
}


exports.insertRegisteredAddress = function*(bitcoinAddress, signature, message) {
  assert(belt.isValidBitcoinAddress(bitcoinAddress));
  assert(typeof signature == 'string');
  assert(typeof message == 'string');

  var sql = `INSERT INTO registered_addresses(bitcoin_address, signature, message)
    VALUES($1, $2, $3) RETURNING id`;

  var r = yield queryOne(sql, [bitcoinAddress, signature, message]);
  return r.id;
}


exports.createForwardingAddress = function*(nick, winAddress) {
  assert(typeof nick === 'string');
  assert(belt.isValidBitcoinAddress(winAddress));

  var index = (yield queryOne("SELECT nextval('forwarding_index_seq') as next")).next;
  var keypair = belt.deriveForwardingKeyPair(index);
  var bitcoinAddress = keypair.getAddress().toString();

  var hookIdentifier = config.get('NODE_ENV') === 'development' ? 'dev-forwarding-tx' : 'forwarding-tx';

  yield blocktrail.newHook(bitcoinAddress, hookIdentifier);

  var message = JSON.stringify({
    nick: nick,
    win_address: winAddress,
    time: new Date(),
    purpose: 'pevpot'
  });

  var signature = bitcoinjs.message.sign(keypair, message).toString('base64');

  var sql = `INSERT INTO registered_addresses(bitcoin_address, message, signature,
    forwarding_index, forwarding_last_check, forwarding_next_check)
    VALUES($1, $2, $3, $4, NOW(), interval '10 minutes') RETURNING id`;

  var r = yield queryOne(sql, [bitcoinAddress, message, signature, index]);

  return r.id;
}

exports.updateForwardingNextSend = function*(forwardingIndex, didSomething) {
  assert(Number.isInteger(forwardingIndex));
  assert(typeof didSomething === 'boolean');

  var sql = `
    UPDATE registered_addresses SET forwarding_last_check = NOW(),
    forwarding_next_check =
      CASE WHEN $1 THEN
             interval '10 minutes'
           WHEN NOW() < forwarding_last_check + forwarding_next_check THEN
             forwarding_next_check
           ELSE
            forwarding_next_check*3
      END
    WHERE forwarding_index = $2
  `;
  var r = yield query(sql, [didSomething, forwardingIndex]);
  assert(r.rowCount === 1);
}

exports.listForwardingNeedSending = function*() {
  var sql = `SELECT forwarding_index FROM registered_addresses
    WHERE NOW() AT TIME ZONE 'utc' > (forwarding_last_check AT TIME ZONE 'utc' + forwarding_next_check)
    ORDER BY (forwarding_last_check AT TIME ZONE 'utc' + forwarding_next_check) ASC
    LIMIT 100
  `;

  return (yield queryMany(sql)).map(x => x.forwarding_index);
}

exports.getInfo = function*() {
  return yield queryOne('SELECT * FROM info');
}

exports.getDrawInfoById = function*(drawId) {
  assert(Number.isInteger(drawId));
  var sql = `
  SELECT *, (
    SELECT to_json(registered_addresses.*) as winner_registration
    FROM registered_addresses WHERE id = winner_registered_address_id
  ), (
    SELECT to_json(lottery_payments.*) as winning_payment
    FROM lottery_payments WHERE id = winning_lottery_payment_id
  )
  FROM draws WHERE id = $1`;
  return yield queryOne(sql, [drawId]);
}

exports.getLatestDraws = function*(from){
  var sql = `SELECT *
  FROM draws
  WHERE id <= $1
  ORDER BY id DESC
  LIMIT 6`;
  return yield queryMany(sql, [from]);
}

exports.getLastFinalizedDrawId = function*() {
  var r = yield queryOne('SELECT COALESCE(MAX(id),0) FROM draws WHERE block_hash IS NOT NULL');
  return r.id;
}

exports.finalizeDraw  = function*(drawId, blockHash, stretched) {
  assert(Number.isInteger(drawId));
  assert(typeof blockHash === 'string');

  yield withTransaction(function*(client) {
    yield client.queryPromise('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

    var r = yield client.queryPromise('UPDATE draws SET block_hash = $1 WHERE id = $2 AND block_hash IS NULL', [blockHash, drawId]);
    if (r.rowCount === 0)
      throw new Error('Could not finalize, already done?');

    var ticketsBought = (
      yield client.queryPromise('SELECT tickets_bought FROM draws WHERE id = $1', [drawId])
    ).rows[0].tickets_bought;

    assert(Number.isInteger(ticketsBought));

    //var blockHashNum = bignum(blockHash, 16);
    // this is the super cpu intensive...
    // var stretched = yield belt.stretch(blockHash);
    var stretchedNum = bignum(stretched, 16);
    var winningTicket = ticketsBought > 0 ? stretchedNum.mod(ticketsBought).toNumber() : -1;

    var winningPaymentQuery = `WITH r AS (
        SELECT SUM(amount) OVER (ORDER BY txid, vout) AS running_total, *
        FROM lottery_payments
        WHERE draw_id = $1 AND dust=false
    ) SELECT * FROM r
    WHERE $2 >= (running_total - amount) AND $2 < running_total`;


    var winningPayment = (
      yield client.queryPromise(winningPaymentQuery, [drawId, winningTicket])
    ).rows[0];

    // There may not be a winning payment, if no one entered the draw..
    if (winningPayment) {
      var blocksSinceDraw = (winningPayment.block_height-1) % 100;
      var fraction = (999 -  blocksSinceDraw) / 999;


      yield client.queryPromise('UPDATE draws SET winner_bonus = (bonus_carry + sponsor_contribution) * $1::float WHERE id = $2', [fraction, drawId]);

      var updateBonusCarryQuery = `
        UPDATE draws SET bonus_carry = (
          SELECT (bonus_carry + sponsor_contribution) * (1.0 - $1::float) FROM draws WHERE id = ($2)
        ) WHERE id = ($2+1)
      `;

      yield client.queryPromise(updateBonusCarryQuery, [fraction, drawId]);
    }

    var winningRegisteredAddressId = null;
    if (winningPayment && winningPayment.sending_bitcoin_address) {
      var winningRegisteredAddressQuery = `SELECT id FROM registered_addresses
        WHERE bitcoin_address = $1
        ORDER BY created
        DESC LIMIT 1
        `;
      var rs = yield client.queryPromise(winningRegisteredAddressQuery, [winningPayment.sending_bitcoin_address]);
      if (rs.rows.length > 0) {
        assert(rs.rows.length === 1);
        winningRegisteredAddressId = rs.rows[0].id;
      }
    }

    var winningPaymentId = winningPayment ? winningPayment.id : null;

    var updateQuery = `UPDATE draws SET
      winning_ticket = $1, winning_lottery_payment_id = $2,
      winner_registered_address_id = $3, stretched_block_hash = $4
      WHERE id = $5`;

    yield client.queryPromise(updateQuery, [
      winningTicket, winningPaymentId,
      winningRegisteredAddressId, stretched,
      drawId
    ]);


  });

}


exports.updateDrawWinnerTxid = function*(drawId, winnerTxid) {
  var r = yield query(`
    UPDATE draws SET winner_txid = $1 WHERE id = $2 AND winner_txid IS NULL
   `, [winnerTxid, drawId]);

  if (r.rowCount !== 1)
    throw new Error('already set?');

  return;
}