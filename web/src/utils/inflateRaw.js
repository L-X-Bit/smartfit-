/**
 * 纯 JS 的 raw DEFLATE 解压（zip 里 method=8 用的就是它）
 * ===========================================================================
 * 为什么需要这么一份"备胎"：
 *   浏览器原生的 `DecompressionStream('deflate-raw')` 很好用，但它有版本门槛——
 *   **iOS / iPadOS Safari 要到 16.4 才有**。拿 iPad 的同学（很常见）导出「健康」数据后
 *   会遇到：文件能选，但点了没反应 / 提示"浏览器不支持解压"。
 *   所以这里补一个零依赖的 inflate 实现，老 Safari 也能把 zip 解开；
 *   代价是走"整块解压"而不是流式解压，所以外层会限制体积，避免把内存吃光。
 *
 * 实现说明（照 RFC 1951）：
 *   · 位读取器：32 位位缓冲，LSB 先出（stored 块的块头之外，Huffman 码按 RFC 是 MSB 先传，
 *     所以快表索引里要把码位**反转**，这一步是这类实现最容易写错的地方）；
 *   · 三种块：stored(0) / 固定 Huffman(1) / 动态 Huffman(2)；
 *   · Huffman 解码用 **10 位快表 + 兜底慢路径**（puff 风格的规范解码）；
 *   · 输出用倍增扩容的缓冲区，不做逐字节 push。
 *
 * 对外只有一个函数：inflateRaw(bytes, { maxOutput }) → Uint8Array
 */

const FAST_BITS = 10;
const FAST_SIZE = 1 << FAST_BITS;
const FAST_MASK = FAST_SIZE - 1;

/** RFC 1951 的长度/距离基值与额外位表 */
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** 码长码的传输顺序（RFC 1951 §3.2.7） */
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** 把 len 位整数按位反转（Huffman 码是 MSB 先传，位缓冲是 LSB 先出） */
function reverseBits(v, len) {
  let r = 0;
  for (let i = 0; i < len; i += 1) {
    r = (r << 1) | (v & 1);
    v >>>= 1;
  }
  return r;
}

/**
 * 由「每个符号的码长」构建解码表
 * @param {Uint8Array|number[]} lengths 长度不超过 15，0 表示该符号不存在
 * @returns {{count:Uint16Array, symbol:Uint16Array, fast:Int32Array}}
 */
function buildHuffman(lengths) {
  const count = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i += 1) count[lengths[i]] += 1;
  count[0] = 0; // 码长 0 = 符号未使用，不参与建表

  // 按码长做规范重排，得到「按码值递增」的符号序列（慢路径靠它定位）
  const offsets = new Uint16Array(16);
  let total = 0;
  for (let len = 1; len < 16; len += 1) {
    offsets[len] = total;
    total += count[len];
  }
  const symbol = new Uint16Array(total);
  for (let s = 0; s < lengths.length; s += 1) {
    const len = lengths[s];
    if (len) symbol[offsets[len]++] = s;
  }

  // 10 位快表：entry = (符号 << 4) | 码长；0 表示"这 10 位不是短码，走慢路径"
  const fast = new Int32Array(FAST_SIZE);
  let code = 0;
  let index = 0;
  for (let len = 1; len <= 15; len += 1) {
    for (let n = 0; n < count[len]; n += 1) {
      if (len <= FAST_BITS) {
        const rev = reverseBits(code + n, len); // 反转后才是位缓冲里看到的样子
        const step = 1 << len;
        for (let k = 0; k < FAST_SIZE; k += step) fast[k + rev] = (symbol[index + n] << 4) | len;
      }
    }
    code = (code + count[len]) << 1;
    index += count[len];
  }

  return { count, symbol, fast };
}

/**
 * raw DEFLATE 解压
 * @param {Uint8Array} input 压缩数据
 * @param {{maxOutput?:number}} [opts] maxOutput：输出上限（字节），超了直接报错，防止内存被吃光
 * @returns {Uint8Array}
 */
export function inflateRaw(input, opts = {}) {
  const maxOutput = opts.maxOutput || 512 * 1024 * 1024;

  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;

  /** 位缓冲填充：保证手上至少有 24 位可用 */
  const fill = () => {
    while (bitCnt <= 24 && pos < input.length) {
      bitBuf |= input[pos] << bitCnt;
      pos += 1;
      bitCnt += 8;
    }
  };

  const bits = (n) => {
    if (n === 0) return 0;
    if (bitCnt < n) {
      fill();
      if (bitCnt < n) throw new Error('压缩数据不完整（意外结尾）');
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };

  /** 解一个 Huffman 符号：先查快表，长码（>10 位）再逐位走规范解码 */
  const decode = (h) => {
    if (bitCnt < FAST_BITS) fill();
    if (bitCnt >= FAST_BITS) {
      const entry = h.fast[bitBuf & FAST_MASK];
      if (entry) {
        const len = entry & 0x0f;
        bitBuf >>>= len;
        bitCnt -= len;
        return entry >>> 4;
      }
    }
    // 慢路径：数据尾部不足 10 位、或码长 > 10 位时走这里
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len += 1) {
      if (bitCnt < 1) fill();
      if (bitCnt < 1) throw new Error('压缩数据不完整（意外结尾）');
      code |= bitBuf & 1;
      bitBuf >>>= 1;
      bitCnt -= 1;
      const c = h.count[len];
      if (code - first < c) return h.symbol[index + (code - first)];
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    throw new Error('非法的 Huffman 编码');
  };

  // 输出缓冲区：倍增扩容
  let out = new Uint8Array(Math.max(1024, Math.min(maxOutput, Math.max(input.length * 4, 1024))));
  let outLen = 0;
  const ensure = (extra) => {
    const need = outLen + extra;
    if (need > maxOutput) throw new Error('解压后的数据过大（超过上限），请改用命令行脚本处理');
    if (need <= out.length) return;
    let cap = out.length;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(Math.min(cap, maxOutput));
    next.set(out.subarray(0, outLen));
    out = next;
  };

  let fixed = null;
  const getFixed = () => {
    if (!fixed) {
      const lit = new Uint8Array(288);
      for (let i = 0; i < 144; i += 1) lit[i] = 8;
      for (let i = 144; i < 256; i += 1) lit[i] = 9;
      for (let i = 256; i < 280; i += 1) lit[i] = 7;
      for (let i = 280; i < 288; i += 1) lit[i] = 8;
      fixed = { lit: buildHuffman(lit), dist: buildHuffman(new Uint8Array(30).fill(5)) };
    }
    return fixed;
  };

  let final = 0;
  do {
    final = bits(1);
    const type = bits(2);

    if (type === 0) {
      // stored 块：先对齐字节边界，再按 LEN/NLEN 原样拷贝
      const drop = bitCnt & 7;
      bitBuf >>>= drop;
      bitCnt -= drop;
      const len = bits(16);
      const nlen = bits(16);
      if (((len ^ 0xffff) & 0xffff) !== nlen) throw new Error('stored 块长度校验失败');

      ensure(len);
      let remaining = len;
      while (remaining > 0 && bitCnt >= 8) {
        out[outLen] = bitBuf & 0xff;
        outLen += 1;
        bitBuf >>>= 8;
        bitCnt -= 8;
        remaining -= 1;
      }
      if (remaining > 0) {
        if (pos + remaining > input.length) throw new Error('stored 块数据不完整');
        out.set(input.subarray(pos, pos + remaining), outLen);
        outLen += remaining;
        pos += remaining;
      }
      continue;
    }

    let lit;
    let dist;
    if (type === 1) {
      ({ lit, dist } = getFixed());
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;

      const clen = new Uint8Array(19);
      for (let i = 0; i < hclen; i += 1) clen[CLEN_ORDER[i]] = bits(3);
      const clHuff = buildHuffman(clen);

      const lengths = new Uint8Array(hlit + hdist);
      let i = 0;
      while (i < lengths.length) {
        const sym = decode(clHuff);
        if (sym < 16) {
          lengths[i] = sym;
          i += 1;
        } else if (sym === 16) {
          if (i === 0) throw new Error('码长重复错误：前面没有可复用的值');
          const prev = lengths[i - 1];
          let n = 3 + bits(2);
          while (n > 0 && i < lengths.length) {
            lengths[i] = prev;
            i += 1;
            n -= 1;
          }
        } else if (sym === 17) {
          let n = 3 + bits(3);
          while (n > 0 && i < lengths.length) {
            lengths[i] = 0;
            i += 1;
            n -= 1;
          }
        } else {
          let n = 11 + bits(7);
          while (n > 0 && i < lengths.length) {
            lengths[i] = 0;
            i += 1;
            n -= 1;
          }
        }
      }

      lit = buildHuffman(lengths.subarray(0, hlit));
      dist = buildHuffman(lengths.subarray(hlit));
    } else {
      throw new Error('非法的块类型（BTYPE=3）');
    }

    // 解符号，直到块结束符 256
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        ensure(1);
        out[outLen] = sym;
        outLen += 1;
      } else if (sym === 256) {
        break;
      } else {
        const li = sym - 257;
        if (li >= LEN_BASE.length) throw new Error('非法的长度符号');
        const length = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const di = decode(dist);
        if (di >= DIST_BASE.length) throw new Error('非法的距离符号');
        const distance = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (distance > outLen) throw new Error('距离越界（数据可能已损坏）');
        ensure(length);
        let from = outLen - distance;
        // 逐字节复制，允许重叠（LZ77 的经典用法）
        for (let k = 0; k < length; k += 1) {
          out[outLen] = out[from];
          outLen += 1;
          from += 1;
        }
      }
    }
  } while (!final);

  return out.subarray(0, outLen);
}
