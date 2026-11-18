import { IRCode, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

const PRE_BITS = 26;
const POST_BITS = 1;
const DATA_BITS = 15;
const TOTAL_BITS = PRE_BITS + DATA_BITS + POST_BITS; // 42
const PRE_DATA = 0x1D8113F; // 26 bits (approx)
const POST_DATA = 1;

export class AiwaProtocol implements ProtocolHandler {
  readonly name = 'Aiwa';

  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw) >>> 0;
    return new IRCode({ protocol: this.name, bits: DATA_BITS, address: (val >> 8) & 0x7f, subaddress: -1, command: val & 0xff, data: val });
  }

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0) & 0x7f;
    const cmd = parseIntVal(args.command ?? args.function ?? 0) & 0xff;
    const data = (addr << 8) | cmd;
    return new IRCode({ protocol: this.name, bits: DATA_BITS, address: addr, subaddress: -1, command: cmd, data });
  }

  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    // Aiwa is an extended NEC frame; reuse NEC timing for 42 bits.
    if (burstPairs.length < TOTAL_BITS + 1) return null;
    const [hdrMark, hdrSpace] = burstPairs[0];
    if (!(hdrMark >= 7500 && hdrMark <= 10500 && hdrSpace >= 3500 && hdrSpace <= 5500)) return null;

    const bytes: number[] = [];
    let data = 0;
    for (let i = 0; i < TOTAL_BITS; i++) {
      const space = burstPairs[i + 1]?.[1] ?? 0;
      const bit = space > 1100 ? 1 : 0;
      data = data * 2 + bit;
    }
    // verify prefix/postfix
    const prefix = Math.floor(data / 2 ** (DATA_BITS + POST_BITS)) & ((1 << PRE_BITS) - 1);
    const postfix = data & 1;
    if (prefix !== PRE_DATA || postfix !== POST_DATA) return null;
    const varData = Math.floor(data / 2 ** POST_BITS) & ((1 << DATA_BITS) - 1);
    const address = (varData >> 8) & 0x7f;
    const command = varData & 0xff;
    return new IRCode({ protocol: this.name, bits: DATA_BITS, address, subaddress: -1, command, data: varData });
  }

  toPronto(code: IRCode): string {
    const varData = (code.data as number);
    const fullData = (PRE_DATA * 2 ** (DATA_BITS + POST_BITS)) + (varData * 2 ** POST_BITS) + POST_DATA;
    const carrierHz = 38000;
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);

    const bits: number[] = [];
    for (let i = TOTAL_BITS - 1; i >= 0; i--) bits.push(Math.floor(fullData / 2 ** i) & 1);

    const burstPairs: BurstPair[] = [[usToPulses(9024), usToPulses(4512)]];
    for (const bit of bits) {
      burstPairs.push([usToPulses(562.5), usToPulses(bit ? 1687.5 : 562.5)]);
    }
    burstPairs.push([usToPulses(564), usToPulses(43992)]);

    const seq1 = burstPairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = burstPairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
