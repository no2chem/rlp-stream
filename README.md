# RLP stream implementation

[![Build Status](https://travis-ci.org/no2chem/rlp-stream.svg?branch=master)](https://travis-ci.org/no2chem/rlp-stream)

This package provides a streaming implementation of the Recursive Length Prefix (RLP) encoding used in Ethereum, 
as specified in the Ethereum yellow paper (yellowpaper.io). You can find API documentation [here](https://no2chem.github.io/rlp-stream/). Typescript definitions are included.

The streaming transform enables efficient reading of large RLP encoded files, such as blockchain dump files
produced by geth. You can obtain blockchain dump files by running:
```sh
$ geth export <file> <start block> <end block>
```

And then use the following script to print out each block one at a time as they are encountered:
```typescript
import {RlpDecoderTransform, RlpItem} from 'rlp-stream';
const asyncChunks = require('async-chunks');

const decoder = new RlpDecoderTransform();
fs.createReadStream(file).pipe(decoder);

for await (const chunk of asyncChunks(decoder)) {
  console.log(JSON.stringify(chunk, null, 2));
}
```

If your implementation has native for-await support, you don't need async-chunks.