import { IRCode, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

const CARRIER = 57600;
const N_BITS = 16;
const HDR_MARK = 400;
const HDR_SPACE = 6100;
const BIT_MARK = 400;
const ONE_SPACE = 1700;
const ZERO_SPACE = 2800;

export class DishProtocol implements ProtocolHandler {
  readonly name = 'Dish_Network';

  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw) >>> 0;
    return new IRCode({ protocol: this.name, bits: N_BITS, address: 0, subaddress: -1, command: val & 0xffff, data: val });
  }

  decodeParams(args: DecodeParams): IRCode {
    const cmd = parseIntVal(args.command ?? args.function ?? args.device ?? 0) & 0xffff;
    return new IRCode({ protocol: this.name, bits: N_BITS, address: 0, subaddress: -1, command: cmd, data: cmd });
  }

  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    if (burstPairs.length < N_BITS + 1) return null;
    const [hdrMark, hdrSpace] = burstPairs[0];
    if (!(hdrMark >= 300 && hdrMark <= 500 && hdrSpace >= 5500 && hdrSpace <= 6700)) return null;
    let data = 0;
    for (let i = 0; i < N_BITS; i++) {
      const mark = burstPairs[i + 1][0];
      const space = burstPairs[i + 1][1];
      if (mark < 300 || mark > 500) return null;
      let bit: number;
      if (space >= (ONE_SPACE + ZERO_SPACE) / 2) bit = 0;
      else if (space <= (ONE_SPACE + ZERO_SPACE) / 2 && space >= ONE_SPACE * 0.5) bit = 1;
      else return null;
      data = (data << 1) | bit;
    }
    return new IRCode({ protocol: this.name, bits: N_BITS, address: 0, subaddress: -1, command: data, data });
  }

  toPronto(code: IRCode): string {
    const data = (code.data as number) >>> 0;
    const freqWord = Math.round(1000000.0 / (CARRIER * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);
    const bits: number[] = [];
    for (let i = N_BITS - 1; i >= 0; i--) bits.push((data >> i) & 1);
    const pairs: BurstPair[] = [[usToPulses(HDR_MARK), usToPulses(HDR_SPACE)]];
    for (const bit of bits) {
      pairs.push([usToPulses(BIT_MARK), usToPulses(bit ? ONE_SPACE : ZERO_SPACE)]);
    }
    const seq1 = pairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = pairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
