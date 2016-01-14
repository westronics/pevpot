var co = require('co');
var config = require('../src/config');
var db = require('../src/db');
var fs = require('co-fs');
var path = require('path');


if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
  throw new Error('Refusing to continue on non-dev environment');
}


function *slurpSql(filePath) {
    var fullPath = path.join(__dirname, filePath);
    return yield fs.readFile(fullPath, 'utf8');
}

co(function*() {
    console.log('Resetting the db...');

    var sql;

    sql = yield slurpSql('schema.sql');
    console.log('Executing schema.sql...');
    yield db.query(sql);

    // seed
    yield db.createSponsor('Prime Dice', 'https://www.primedice.com',
      yield fs.readFile(path.join(__dirname, 'primedice.png'))
    );

    yield db.createSponsor('Rollin', 'https://www.rollin.io',
      yield fs.readFile(path.join(__dirname, 'rollin.png'))
    );

    yield db.createSponsor('Bustabit', 'https://www.bustabit.com',
      yield fs.readFile(path.join(__dirname, 'bustabit.png'))
    );

    var adPayments = `INSERT INTO sponsor_payments(sponsor_id, txid, vout, block_height, amount, dust, draw_id)
       VALUES(1, 'f221dbeb221b402c2764af86913053289535a2ab19083da15b9dec730da93ce4', 1, null, 1160000, false, 1),
             (1, 'b30679bf3c688ad8f8b674a25c33399be23234934a488c04b8666f9486c1e5f3', 954, 319139, 1000, true, 1),
             (1, '96408c3e2b9ab3c35d3c5666b53430f40a6b202e2b84892c244dd8f12533896c', 0, 281582, 15000000000, false, 1),
             (1, 'b858664d833586e5cd867079683fb952712313853457318eb4b4a2a925d124f0', 0, 281553, 40000000000, false, 2),
             (1, 'caf0f3ebdeeb91f896e9979b5dd4b35bbe4fdc0753519a0b751af61781e4e93f', 0, 281551, 5000000000, false, 2),
             (2, 'ca8b38b5cd7709363776aab0fe2f07b450a243bc9044bf0290674fcdf404fd60', 1, 281551, 78640000, false, 2),
             (2, 'd97de038f07eae3da9e3adcd4e69a1701c9b2d114cd4e3c2142c7e88202c985f', 1, 382685, 10000000000, false, 1),
             (3, '79f71c1dedcc2aa7bc7727afecb822c00073730fddd1ca449757f5d55c988e31', 0, 382685, 3757225889, false, 3),
             (3, '07975850c8a69d7d1e4a7b91b5a6ec6c8b3877327b951e51ab6886dcbd94222b', 3, 382680, 1, true, 3),
             (3, 'c6113b478ac25dd12c1a788b0c5cf551068b30e3b7002cbac47685f78a77aa46', 1, 382680, 50000000, false, 3)

    `;
    yield db.query(adPayments);

    var lotteryPayments = `INSERT INTO lottery_payments(draw_id, txid, vout, amount,
       dust, sending_bitcoin_address, block_height)
    VALUES(1, '4294217a2ea78988e9ddc303bbb87eb3730b652ca5dbbb3f9b3a37edbeb9adc8', 0, 21639910,
          false, '1FDpC6QrCxjG54mDb3LEnpowz76TrshLq', 382711),
          (2, 'b7b0ea52bc80edd159a1c1f0f88f85be68908cc09665082dec993daa25c6caeb', 1, 70637629,
           false, '195bBt8YqamTG5meBjgfudewS7p28muwSk', 382709),
          (1, '90d803b38fcaadb7d6807bb652f4c67e9a1d135dfaafd1675fd437ae796e6dca', 1, 2449990000,
           false, '144ANsaCK777pgwCQcZeNL91pTN2WKcHgx', 382716) 
           `;
    yield db.query(lotteryPayments);


    yield db.createForwardingAddress('John', '1BitcoinEaterAddressDontSendf59kuE');
    yield db.createForwardingAddress('CP', '1CounterpartyXXXXXXXXXXXXXXXUWLpVr');


    
    
    yield db.query('UPDATE info SET lottery_scanned_height = $1', [config.get('STARTING_BLOCK') + 1500]);
    
    console.log('~~ finalizing draw 1, will take a long time~~');
    return co(function*() {
      yield db.finalizeDraw(1, '00000000000000000ef86b27c174df6a412c0ce43eab1d532034555749294137');
    });

}).then(function() {
    console.log('Finished resetting db');
    process.exit(0);
}, function(err){
    console.error('Caught error: ', err, err.stack);
    process.exit(1);
});
