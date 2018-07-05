import 'mocha';

import * as chai from 'chai';
import * as fs from 'fs-extra';
import * as path from 'path';

import {RlpDecode, RlpDecoderTransform, RlpEncode, RlpEncoderTransform, RlpList} from './rlp-stream';

const asyncChunks = require('async-chunks');

// Needed for should.not.be.undefined.
/* tslint:disable:no-unused-expression */

chai.should();

const GENESIS_BLOCK = 'test_data/genesis.bin';
const BLOCK_1M = 'test_data/1M.bin';
const BLOCK_4M = 'test_data/4M.bin';
const BLOCK_FIRST10 = 'test_data/first10.bin';

const loadStream = (filename: string) => {
  const decoder = new RlpDecoderTransform();
  fs.createReadStream(path.join(__dirname, filename)).pipe(decoder);
  return decoder;
};

const ETH_BLOCK_HEADER = 0;
const ETH_TRANSACTION_LIST = 1;

const ETH_HEADER_MINER = 2;
const ETH_HEADER_BLOCKNUM = 8;

describe('Decode binary genesis block', async () => {
  let block: RlpList;

  before(async () => {
    block = (await asyncChunks(loadStream(GENESIS_BLOCK)).next()).value;
  });

  it('should have correct miner', async () => {
    (block[ETH_BLOCK_HEADER][ETH_HEADER_MINER] as Buffer)
        .toString('hex')
        .should.equal('0000000000000000000000000000000000000000');
  });

  it('should have no transactions', async () => {
    block[ETH_TRANSACTION_LIST].length.should.equal(0);
  });
});

describe('Decode block 1M', async () => {
  let block: RlpList;

  before(async () => {
    block = (await asyncChunks(loadStream(BLOCK_1M)).next()).value;
  });

  it('should have correct miner', async () => {
    (block[ETH_BLOCK_HEADER][ETH_HEADER_MINER] as Buffer)
        .toString('hex')
        .should.equal('2a65aca4d5fc5b5c859090a6c34d164135398226');
  });

  it('should have 2 transactions', async () => {
    block[ETH_TRANSACTION_LIST].length.should.equal(2);
  });
});


describe('Decode block 4M', async () => {
  let block: RlpList;

  before(async () => {
    block = (await asyncChunks(loadStream(BLOCK_4M)).next()).value;
  });

  it('should have correct miner', async () => {
    (block[ETH_BLOCK_HEADER][ETH_HEADER_MINER] as Buffer)
        .toString('hex')
        .should.equal('1e9939daaad6924ad004c2560e90804164900341');
  });

  it('should have 69 transactions', async () => {
    block[ETH_TRANSACTION_LIST].length.should.equal(69);
  });
});


describe('Decode first 10 blocks', async () => {
  const blocks: RlpList[] = [];

  before(async () => {
    for await (const chunk of asyncChunks(loadStream(BLOCK_FIRST10))) {
      blocks.push(chunk);
    }
  });

  it('should have 10 blocks', async () => {
    blocks.length.should.equal(10);
  });

  it('block 3 should have correct block number', async () => {
    (blocks[3][ETH_BLOCK_HEADER][ETH_HEADER_BLOCKNUM] as Buffer)
        .toString('hex')
        .should.equal('03');
  });

  it('block 6 should have correct miner', async () => {
    (blocks[6][ETH_BLOCK_HEADER][ETH_HEADER_MINER] as Buffer)
        .toString('hex')
        .should.equal('0193d941b50d91be6567c7ee1c0fe7af498b4137');
  });

  it('block 9 should have no transactions', async () => {
    blocks[9][ETH_TRANSACTION_LIST].length.should.equal(0);
  });
});

describe('Encoding and decoding a RLP stream', async () => {
  it('should decode what is encoded', async () => {
    const decoder = new RlpDecoderTransform();
    const encoder = new RlpEncoderTransform();

    encoder.pipe(decoder);
    const data: RlpList = [
      [], [Buffer.from([0]), Buffer.from([0]), Buffer.from([0])],
      [Buffer.from([5]), Buffer.from([6]), Buffer.from([4]), []]
    ];
    data.forEach(e => encoder.write(e));
    const iterator = asyncChunks(decoder);

    for (let i = 0; i < data.length; i++) {
      const decoded = await iterator.next();
      decoded.done.should.be.false;
      decoded.value.should.deep.equals(data[i]);
    }
  });
});

describe('Encoding and decoding RLP list', async () => {
  const listToEncode = [Buffer.from([0, 1, 2, 3, 4]), Buffer.from([0])];

  it('should encode into a buffer', async () => {
    Buffer.isBuffer(RlpEncode(listToEncode)).should.be.true;
  });


  it('should encode and decode', async () => {
    RlpDecode(RlpEncode(listToEncode)).should.deep.equal(listToEncode);
  });
});