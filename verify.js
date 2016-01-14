var forge = require('node-forge');
forge.disableNativeCode = true;

function stretchBlockHash(blockHash) {
  return new forge.util.ByteBuffer(
    forge.pbkdf2(blockHash, 'pevpot', 5000000000, 32, 'sha256')
  ).toHex();
}


var hash = '000000000000000009b7fb236187f120a0c86eb8785f099a8d197dd34b9d2553';
console.log('The stretch of: ', hash, ' is\n', stretchBlockHash(hash));
