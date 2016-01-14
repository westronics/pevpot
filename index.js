var bouncer = require('koa-bouncer');
var debug = require('debug')('app:index');
var koa = require('koa');
var bodyParser = require('koa-bodyparser');
var serve = require('koa-static');
var nunjucks = require('koa-nunjucks-render');
var logger = require('koa-logger')
var timeAgo = require('simple-timeago');

var belt = require('./src/belt');
var config = require('./src/config');
var routes = require('./src/routes');

var app = koa();
app.use(logger());

app.use(serve('public', {
  maxage: config.get('NODE_ENV') === 'development' ? 0 : 7.2e6, // 2 hours in ms
  gzip: false
}));

app.use(nunjucks('views', {
  ext: '.html',
  noCache: config.get('NODE_ENV') === 'development',
  throwOnUndefined: true,
  filters: {
    json: function(str) {
      return JSON.stringify(str, null, 2);
    },
    uriEncode: function(str) {
      return encodeURIComponent(str);
    },
    formatSatoshis: belt.formatSatoshis,
    formatNumber: belt.formatNumber,
    timeAgo: timeAgo
  },
  globals: {
    lottoAddress: config.get('LOTTERY_ADDRESS'),
    dustThreshold: config.get('DUST_THRESHOLD')
  }
}));

app.use(bodyParser());
app.use(function*(next) {
  try {
    yield* next;
  } catch(ex) {
    if (ex instanceof bouncer.ValidationError) {
      this.body = 'Got validation error: ' + ex.message;
      return;
    }
    throw ex;
  }
})
app.use(bouncer.middleware());
app.use(routes.routes());
app.use(routes.allowedMethods());

app.listen(config.get('PORT'), () => {
  console.log('Listening on port ' + config.get('PORT'));
});


// cron

var co = require('co');
var db = require('./src/db');
var forwardingTransaction = require('./src/forwarding_transaction');

function check() {
  co(function*() {
    var forwardingIndexes = yield db.listForwardingNeedSending();
    debug('Got %d forwarding addresses needing checking', forwardingIndexes.length);
    for (var i of forwardingIndexes) {
        yield forwardingTransaction.createPushAndUpdateDbNextSend(i);
    }
  }).then(function() {
    console.log('Checked forwarding addresses');
  }, function(err) {
    console.error('Caught forwarding address error: ', err, err.stack);
  });
}

// check every 10
check();
setInterval(check, 100*1000*1000);
