import {Transform, TransformOptions} from 'stream';
const rlp = require('rlp');

/**
 * A helper class which buffers the input byte stream, providing a concatenated
 * byte buffer if there are insufficent bytes to perform the transform.
 *
 * To use, implement the do_transform and do_flush functions.
 */
export abstract class BufferedTransform<O> extends Transform {
  /**
   * A buffer which holds bytes between transform calls.
   */
  private buffer: Buffer|null = null;

  /**
   * The number of transformed bytes
   */
  protected transformedBytes = 0;

  /**
   * Constructor.
   */
  constructor() {
    super({
      transform: (chunk: Buffer, encoding: string, callback: Function) => {
        const remaining = this.do_transform(
            this.buffer == null ? chunk : Buffer.concat([this.buffer, chunk]));
        // If there are bytes remaining to be decoded
        if (remaining !== null) {
          this.transformedBytes += chunk.length - remaining.length;
          this.buffer = remaining;
          // If there are no bytes remaining to be decoded.
        } else {
          this.transformedBytes += chunk.length;
          this.buffer = null;
        }
        // Callback, continuing operation.
        callback();
      },
      // Flush the stream.
      flush: (callback) => {
        this.do_flush();
        callback();
      },
      readableObjectMode: true
    });
  }

  /**
   * User implmentation of the transform.
   *
   * @param {Buffer} chunk        The chunk of bytes to transform.
   * @returns {Buffer | null}     Return a buffer of left over bytes not transformed, or null,
   *                              if all bytes were transformed.
   */
  protected abstract do_transform(chunk: Buffer): Buffer|null;

  /** Write transformed bytes out to the stream. */
  protected write_output(output: O) {
    this.push(output);
  }

  /**
   * Action to take when the stream is flushed. Typically this means to
   * transform any remaining bytes. The default implementation does nothing.
   */
  protected do_flush(): void {}
}

/**
 * An RlpItem is either a buffer, or a list (array) which can contain more
 * RlpItems.
 */
export type RlpItem = Buffer|RlpList;

/**
 * This interface is for an RlpList (an array of RlpItems) and allows RlpItems
 * to contain themselves.
 */
export class RlpList extends Array<RlpItem> {}

/** This class represents an RLP formatting error. */
export class RlpFormatError extends Error {
  constructor(message: string, public rlpFilePosition: number) {
    super(`${message} at position ${rlpFilePosition}`);
  }
}

/** Holds data about lists being transformed. */
class ListSizeData {
  /** The number of bytes remaining in the list to read. */
  remaining: number;

  /** The total number of bytes which should be read by this list. */
  total: number;

  /**
   * Constructor
   * @param {size}        The number of bytes in the list to read.
   * @param {sizeField}   The size of the size field for the list.
   */
  constructor(size: number, sizeField: number) {
    this.remaining = size;
    this.total = size + sizeField;
  }

  /**
   * Consume some number of bytes in the list, updating the remaining bytes to
   * read.
   *  @param {bytes}      The number of bytes to consume.
   *  @param {pos}        The curent position.
   */
  consume(bytes: number, pos: number) {
    this.remaining -= bytes;
    if (this.remaining < 0) {
      throw new RlpFormatError(
          `Incorrect list size: expected ${this.total} but got ${
              this.total - this.remaining}`,
          pos);
    }
  }
}

/**
 * An RLP (Recursive Length Prefix) transform, which decodes data encoded
 * according to the RLP serialization format used by Ethereum and as specified
 * in the Yellow Paper (yellowpaper.io).
 */
export class RlpDecoderTransform extends BufferedTransform<RlpItem> {
  /** Index signature. */
  [index: number]: RlpItem;

  // Decoder state machine states
  readonly SM_INPUT = 0;
  readonly SM_INPUT_LONGSTRING = 1;
  readonly SM_INPUT_LONGLIST = 2;
  readonly SM_DECODE_ITEM = 3;

  // Current state machine state
  private state = this.SM_INPUT;

  // Stack of lists
  private listStack: RlpList[] = [];

  // Stack of list sizes
  private listSizeStack: ListSizeData[] = [];

  // Length of the current item to read
  private length = 0;

  // Length of a "long" (>55 byte) item's length field in bytes
  private lengthFieldSize = 0;

  /**
   * Add a decoded item to be queued for output. If the item is not part of a
   * list, it will be output immediately, otherwise, it will be added as part of
   * the current list.
   *
   * @param {item}        The RLP item to add.
   * @param {pos}         The current position of the decode.
   * @param {size}        The size of the RLP item, in bytes.
   * @param {sizeField}   The size of the size field, in bytes.
   * @param {list}        Optional parameter, specifying if the item is a list.
   */
  private add_item(
      item: RlpItem, pos: number, size: number, sizeField: number,
      list = false) {
    if (this.listStack.length === 0 && (!list || (list && size === 0))) {
      // Not in a list, output single item
      this.write_output(item);
    } else if (!list || (list && size === 0)) {
      // In a list, add to list
      this.listStack[this.listStack.length - 1].push(item);
      // Size doesn't include length field
      this.listSizeStack[this.listSizeStack.length - 1].consume(
          size + sizeField, this.transformedBytes + pos);
      while (this.listSizeStack.length > 0 &&
             this.listSizeStack[this.listSizeStack.length - 1].remaining ===
                 0) {
        // List is complete, remove from stacks
        const outListSize = this.listSizeStack.pop();
        const outList = this.listStack.pop();
        // Make sure we have a list
        if (outList === undefined || outListSize === undefined) {
          throw new RlpFormatError(
              'Expected list but no list left', this.transformedBytes + pos);
        }
        // Write out if there are no more lists left
        if (this.listStack.length === 0) {
          this.write_output(outList);
        } else {
          // Otherwise fold into previous list
          this.listStack[this.listStack.length - 1].push(outList);
          // And update the bytes that we read for this list
          this.listSizeStack[this.listSizeStack.length - 1].consume(
              outListSize.total, this.transformedBytes + pos);
        }
      }
    } else {
      // Start a new list
      this.listStack.push(item as RlpList);
      this.listSizeStack.push(new ListSizeData(size, sizeField));
    }
  }

  /** Perform the RLP transformation on an input buffer. */
  do_transform(chunk: Buffer): Buffer|null {
    // Current position in the buffer
    let pos = 0;
    while (pos < chunk.length) {
      switch (this.state) {
        case this.SM_INPUT:
          if (chunk[pos] <= 0x7F) {
            const buf = chunk.slice(pos, pos + 1);
            if (buf.length === 0) {
              console.log('zero');
            }
            this.add_item(buf, pos, 1, 0);
            // Back to INPUT state.
          } else if (chunk[pos] <= 0xB7) {
            this.length = chunk[pos] - 0x80;
            this.lengthFieldSize = 0;
            // Next step is to decode the item.
            this.state = this.SM_DECODE_ITEM;
          } else if (chunk[pos] <= 0xBF) {
            this.lengthFieldSize = chunk[pos] - 0xB7;
            // Next step is to obtain the item length.
            this.state = this.SM_INPUT_LONGSTRING;
          } else if (chunk[pos] <= 0xF7) {
            this.add_item(new RlpList(), pos, chunk[pos] - 0xC0, 1, true);
            // Back to INPUT state.
          } else {
            this.lengthFieldSize = chunk[pos] - 0xF7;
            // Next step is to obtain the list length.
            this.state = this.SM_INPUT_LONGLIST;
          }
          pos++;
          break;
        case this.SM_INPUT_LONGSTRING:
          if (this.lengthFieldSize <= (chunk.length - pos)) {
            this.length = chunk.readUIntBE(pos, this.lengthFieldSize);
            pos += this.lengthFieldSize;
            // Next step is to decode the item
            this.state = this.SM_DECODE_ITEM;
          } else {
            // Not enough data to decode, wait for next op.
            return chunk.slice(pos, chunk.length);
          }
          break;
        case this.SM_INPUT_LONGLIST:
          if (this.lengthFieldSize <= (chunk.length - pos)) {
            this.add_item(
                new RlpList(), pos, chunk.readUIntBE(pos, this.lengthFieldSize),
                this.lengthFieldSize + 1, true);
            pos += this.lengthFieldSize;
            // Ready for next input
            this.state = this.SM_INPUT;
          } else {
            // Not enough data to decode, wait for next op.
            return chunk.slice(pos, chunk.length);
          }
          break;
        case this.SM_DECODE_ITEM:
          if (this.length <= (chunk.length - pos)) {
            this.add_item(
                chunk.slice(pos, pos + this.length), pos, this.length,
                this.lengthFieldSize + 1);
            pos += this.length;
            // Ready for next input
            this.state = this.SM_INPUT;
          } else {
            return chunk.slice(pos);
          }
          break;
        default:
          throw new RlpFormatError(
              `Unknown state machine state ${this.state}`, pos);
      }
    }
    return null;
  }
}

/**
 * An RLP (Recursive Length Prefix) transform, which encodes RLPItems and encodes them
 * according to the RLP serialization format used by Ethereum and as specified
 * in the Yellow Paper (yellowpaper.io).
 */
export class RlpEncoderTransform extends Transform {
  constructor() {
    super({
      transform: (chunk: RlpItem, encoding: string, callback: Function) => {
        this.push(rlp.encode(chunk));
        callback();
      },
      writableObjectMode: true
    });
  }
}

/** Encodes the given RLP list into a RLP-encoded buffer.
 *  @param {data}      The data to encode.
 */
export function RlpEncode(data: RlpItem): Buffer {
  return rlp.encode(data);
}

/** Decodes the given Buffer into a RlpItem.
 *  @param {data}      The data to encode.
 */
export function RlpDecode(data: Buffer): RlpItem {
  return rlp.decode(data);
}