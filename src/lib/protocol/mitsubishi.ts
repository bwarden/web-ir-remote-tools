import { IRCode, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

const CARRIER = 33000;
const N_BITS = 16;
const BIT_MARK = 300;
const ONE_SPACE = 2100;
const ZERO_SPACE = 900;

export class MitsubishiProtocol implements ProtocolHandler {
  readonly name = 'Mitsubishi';

  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw) >>> 0;
    return new IRCode({ protocol: this.name, bits: N_BITS, address: (val >> 8) & 0xff, subaddress: -1, command: val & 0xff, data: val });
  }

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0) & 0xff;
    const cmd = parseIntVal(args.command ?? args.function ?? 0) & 0xff;
    const data = (addr << 8) | cmd;
    return new IRCode({ protocol: this.name, bits: N_BITS, address: addr, subaddress: -1, command: cmd, data });
  }

  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    if (burstPairs.length < N_BITS) return null;
    let data = 0;
    for (let i = 0; i < N_BITS; i++) {
      const mark = burstPairs[i][0];
      const space = burstPairs[i][1];
      if (mark < 250 || mark > 350) return null;
      let bit: number;
      if (Math.abs(space - ONE_SPACE) < 200) bit = 1;
      else if (Math.abs(space - ZERO_SPACE) < 200) bit = 0;
      else return null;
      data = (data << 1) | bit;
    }
    return new IRCode({ protocol: this.name, bits: N_BITS, address: (data >> 8) & 0xff, subaddress: -1, command: data & 0xff, data });
  }

  toPronto(code: IRCode): string {
    const data = (code.data as number) >>> 0;
    const freqWord = Math.round(1000000.0 / (CARRIER * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);
    const bits: number[] = [];
    for (let i = N_BITS - 1; i >= 0; i--) bits.push((data >> i) & 1);
    const pairs: BurstPair[] = [];
    for (const bit of bits) {
      pairs.push([usToPulses(BIT_MARK), usToPulses(bit ? ONE_SPACE : ZERO_SPACE)]);
    }
    const seq1 = pairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = pairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
