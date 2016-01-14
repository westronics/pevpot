var busboy = require('co-busboy');
var router = require('koa-router')();
var bitcoinjsMessage = require('bitcoinjs-message')
var db = require('../db');
var gm = require('gm').subClass({ imageMagick: true });
var url = require('url');



var sponsorPayments = require('../sponsor_payments');
var belt = require('../belt');
var config = require('../config');
var forwardingTransaction = require('../forwarding_transaction');
var lotteryPayments = require('../lottery_payments');
var block = require('../block');
var draw = require('../draw');


router.get('/', function*(next) {
  var scannedHeight = (yield db.getInfo()).lottery_scanned_height;
  var currentDraw = belt.getDrawId(scannedHeight+1);


  var t = yield [
    db.getLatestDraws(currentDraw),
    db.getLatestTickets(),
    db.getSponsorsByDrawId(currentDraw, 5)
  ];

  var drawHistory = t[0];
  var draw = drawHistory.shift();
  var payments = t[1];
  var sponsors = t[2];

  var drawEnd = belt.getDrawEndByDrawId(currentDraw);
  var blocksToGo = drawEnd - scannedHeight;

  const millisecondsIn10M = 600000;
  const estimatedEnd = new Date(+new Date() + millisecondsIn10M*blocksToGo);

  yield this.render('index', {
    draw: draw,
    drawHistory: drawHistory,
    drawEnd: drawEnd,
    estimatedEnd: estimatedEnd,
    blocksToGo: blocksToGo,
    sponsors: sponsors,
    payments: payments
  });
});

router.get('/play', function*() {
  yield this.render('play');
});

router.post('/play', function*() {
  this.validateBody('nick').isString().isLength(0, 100);
  this.validateBody('win_address').checkPred(belt.isValidBitcoinAddress);

  var id = yield db.createForwardingAddress(this.vals['nick'], this.vals['win_address']);

  this.redirect('/registrations/' + id);
});


router.get('/registrations/:id', function*(next) {
  var id = this.params.id;
  if (!belt.isValidUuid(id))
    return yield* next;

  var registration = yield db.getRegisteredAddressById(id);
  if (!registration)
    return yield* next;

  var details = JSON.parse(registration.message);

  var guarantee;

  if (registration.forwarding_index) {
    var msg = 'PevPot generated ' + registration.bitcoin_address +
      ' as a forwarding address on ' + registration.created.toISOString() +
      '. All funds sent to it will be forwarded to the lotto address and should it win,' +
      ' all prize money will be sent to ' + details.win_address;

    guarantee = {
      message:  msg,
      signature: belt.signGuarantee(msg),
      address: belt.guaranteeAddress()
    };
  }

  yield this.render('show_registration', {
    registration: registration,
    details: details,
    guarantee: guarantee
  });
});

router.get('/sponsors', function*() {
  var nextSponsors = yield db.getNextDrawSponsors();
  var newestSponsors = yield db.getNewestSponsors();
  var biggestSponsors = yield db.getBiggestAllTimeSponsors();

  yield this.render('sponsors', {
    nextSponsors: nextSponsors,
    newestSponsors: newestSponsors,
    biggestSponsors: biggestSponsors
  });
});

router.get('/sponsors/:id', function*(next) {
  this.validateParam('id').toInt();

  var sponsor = yield db.getSponsorById(this.vals['id']);
  if (!sponsor)
    return yield* next;

  var draws = yield db.getDrawsSponsorPaymentsBySponsor(this.vals['id']);

  yield this.render('show_sponsor', { sponsor: sponsor, draws: Array.from(draws.entries()) });
});

router.all('/sponsors/:id/process', function*(next) {
  this.validateParam('id').toInt();

  var sponsor = yield db.getSponsorById(this.vals['id']);
  if (!sponsor)
    return yield* next;

  yield sponsorPayments.process(sponsor.bitcoin_address);

  this.body = 'success';
});

router.get('/sponsors/:id/pic', function*(next) {
  var id = parseInt(this.params.id);
  if (!Number.isInteger(id))
    return yield* next;

  var pic = yield db.getSponsorPic(id);
  if (!pic)
    return yield* next;

  // We don't support changing the image..
  this.set('Cache-Control', 'max-age=31536000');
  this.type = 'image/png';
  this.body = pic;
});

router.post('/sponsors', function*(next) {
  if (!this.request.is('multipart/*'))
    return this.throw(400, 'Not multipart');

  var parts = busboy(this);

  var body = new Map();
  var part;
  var buffer;

  while (part = yield parts) {
      if (Array.isArray(part)) {
        body.set(part[0], part[1].trim());

      } else {
        try {
          buffer = yield streamToBuffer(part, 102400);
          buffer = yield processImage(buffer, 160, 60);
        } catch (ex) {
          if (typeof ex === 'string') {
            this.throw(400, ex);
          }

          console.error('[INTERNAL_ERROR] with image: ', ex);
          this.throw('Was unable to process image');
          return;
        }
      }
  }
  var name = body.get('name');
  if (!name || name.length > 100)
    this.throw(400, 'Bad name, required field');

  var originalUrl = body.get('url')
  if (!originalUrl || originalUrl.length > 1024)
    this.throw(400, 'Bad url. Required, and must be less than 1024 chars');

  u = url.parse(originalUrl);

  if (!u)
    this.throw(400, 'Could not parse url');

  if (u.protocol !== 'http:' && u.protocol !== 'https:' )
    this.throw(400, 'Could not parse url protocol');

  if (!u.host)
    this.throw(400, 'Could not parse url host');


  var id = yield db.createSponsor(name, originalUrl, buffer);

  this.redirect('/sponsors/' + id);
});


router.get('/sponsor', function*() {
  yield this.render('sponsor', {});
});

router.all('/draws/:n/process', function*(next) {
  this.validateParam('n').toInt();
  yield draw.process(this.vals['n']);
  this.body = 'success';
});

router.get('/draws/:id', function*(next) {
  this.validateParam('id').toInt().checkPred(x => x >= 1);

  var drawInfo = yield db.getDrawInfoById(this.vals['id']);
  if (!drawInfo)
    return yield* next;

  var scannedHeight = (yield db.getInfo()).lottery_scanned_height;
  var currentDraw = belt.getDrawId(scannedHeight+1);

  if (drawInfo.id > currentDraw)
    return yield* next;

  var sponsors = yield db.getSponsorsByDrawId(this.vals['id'], 5);
  var payments = yield db.getLotteryPaymentsByDrawId(this.vals['id']);

  var ticket = 0;
  for (var payment of payments) {
    payment.from = ticket;
    ticket += payment.amount;
    payment.to = ticket - 1;
  }

  yield this.render('draw', {
    draw: drawInfo,
    blockHeight: belt.getDrawHashHeightByDrawId(this.vals['id']),
    sponsors: sponsors,
    payments: payments
  });
});

router.get('/draws/:id/sponsors', function*(next) {
  this.validateParam('id').toInt();

  var sponsors = yield db.getSponsorsByDrawId(this.vals['id'], 250);
  if (!sponsors)
    return yield* next;

  yield this.render('draw_sponsors', {
    drawId: this.vals['id'],
    sponsors: sponsors
  });
});

router.get('/faq', function*() {
  yield this.render('faq', {});
});

router.get('/how-to-play', function*() {
  yield this.render('how_to_play', {});
});

router.get('/register', function*() {
  yield this.render('register', {
    currentTime: new Date()
  });
});

router.post('/register', function*() {
  this.validateBody('bitcoin-address').required().trim().checkPred(x => belt.isValidBitcoinAddress(x));
  this.validateBody('signature').required().trim().isLength(10,2048, 'Signature must be valid').isBase64();
  this.validateBody('message').required().trim().isLength(10,2048, 'Invalid message size').isJson();

  var message = JSON.parse(this.vals['message']);

  this.validateBody('message').check(
    typeof message.nick == 'string', 'Missing nick in message');
  this.validateBody('message').check(
    belt.isValidBitcoinAddress(message.win_address), 'Invalid win address')
  this.validateBody('message').check(
    belt.isISO8601(message.time, 'Invalid time'));
  this.validateBody('message').check(
    message.purpose === 'pevpot', 'Purpose must be pevpot');

  this.validateBody('signature').check(
    bitcoinjsMessage.verify(this.vals['bitcoin-address'],  this.vals['signature'], this.vals['message']),
    'Signature doesn\'t seem to match'
  );

  var id = yield db.insertRegisteredAddress(this.vals['bitcoin-address'], this.vals['signature'], this.vals['message']);

  this.redirect('/registrations/' + id);
});

router.get('/provably-fair', function*() {
  yield this.render('provably_fair', {});
});

router.get('/how-it-works', function*() {
  yield this.render('how-it-works', {});
});

router.get('/contact', function*() {
  yield this.render('contact', {});
});

function streamToBuffer(stream, maxSize) {
  return new Promise(function(resolve, reject) {
    var used = 0;
    var chunks = [];

    stream.on('data', function(chunk) {
      used += chunk.length;
      chunks.push(chunk);


      if (used > maxSize) {
        stream.removeAllListeners('data');
        reject('TOO_BIG');
      }

    });

    stream.on('error', function(e) {
      reject(e);
    });

    stream.on('end', function() {
      resolve(Buffer.concat(chunks));
    });
  });
}

router.get('/registrations/:id/process', function*(next) {
  var id = this.params.id;
  if (!belt.isValidUuid(id))
    return yield* next;

  var registration = yield db.getRegisteredAddressById(id);
  if (!registration || !registration.forwarding_index)
    return yield* next;

  var r = yield forwardingTransaction.createPushAndUpdateDbNextSend(registration.forwarding_index);
  this.body = r ? 'FORWARDED' : 'NOTHING_TO_FORWARD';
});

// this is called by blocktrail
router.post('/hook-sponsor-tx', function*(next) {

  console.log('Got body: ', this.request.body);

  var body = this.request.body;

  if (!body || !body.addresses)
    return yield* next;


  var addresses = body.addresses;
  for (var address in addresses) {
    if (!belt.isValidBitcoinAddress(address)) {
      console.warn('Not a valid bitcoin address:', address);
      continue;
    }
    console.log('Processing: ', address);
    yield sponsorPayments.process(address);

  }

  this.body = 'success';
});

// this is called by blocktrail
router.post('/hook-forwarding-tx', function*(next) {
  var body = this.request.body;

  console.log('Got forwarding body: ', body);

  if (!body || !body.addresses)
    return yield* next;


  var addresses = body.addresses;
  for (var address in addresses) {
    if (!belt.isValidBitcoinAddress(address)) {
      console.warn('Not a valid bitcoin address:', address);
      continue;
    }

    var registration = yield db.getRegisteredAddressByForwardingBitcoinAddress(address);
    if (!registration) {
      console.warn(' address ', address, ' is not a forwarding address');
      continue;
    }

    var r = yield forwardingTransaction.createPushAndUpdateDbNextSend(registration.forwarding_index);
    console.log('Address: ', address, (r ? 'FORWARDED' : 'NOTHING_TO_FORWARD'));
  }

  this.body = 'success';
});

router.all('/hook-lottery-payment', function*() {
  yield lotteryPayments.process();
  this.body = 'success';
});

router.all('/hook-block', function*() {
  yield block.process();
  this.body = 'success';
});

router.all('/verify', function*() {
  yield this.render('verify');
});

var computing = false;
var computed = false;


router.get('/super-secret-finalize', function*() {
  this.validateQuery('draw').required().toInt();
  this.validateQuery('hash').required().match(/^[\da-f]{64}$/);
  this.validateQuery('stretched').required().match(/^[\da-f]{64}$/);


  yield db.finalizeDraw(this.vals['draw'], this.vals['hash'], this.vals['stretched']);

  this.body = 'Done!';
});

router.get('/super-secret-txid', function*() {
  this.validateQuery('draw').required().toInt();
  this.validateQuery('txid').required().match(/^[\da-f]{64}$/);

  yield db.updateDrawWinnerTxid(this.vals['draw'], this.vals['txid']);

  this.body = 'Done!';
});

function processImage(buff, requiredWidth, requiredHeight) {
  return new Promise(function(resolve, reject) {

    var img = gm(buff)
      .size(function(err, size) {
        if (err) {
          console.error('Could not get image size', err);
          return reject('NOT_AN_IMAGE');
        }

        if (size.width !== requiredWidth || size.height !== requiredHeight)
          return reject('INVALID_SIZE');

        img.strip().toBuffer('png', function(err, buffer) {
          if (err) return reject(err);

          resolve(buffer);
        })
      });
  });
}


module.exports = router;
