import { IRCode, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

const TICK = 26;
const BIT_MARK = 10 * TICK;   // 260
const ONE_SPACE = 70 * TICK;  // 1820
const ZERO_SPACE = 30 * TICK;  // 780
const GAP = 1677 * TICK;      // ~43600
const CARRIER = 38000;
const N_BITS = 15;

export class SharpProtocol implements ProtocolHandler {
  readonly name: string;
  constructor(name = 'DENON') { this.name = name; }

  private pack(address: number, command: number): number {
    return ((address & 0x1f) << 10) | ((command & 0xff) << 2);
  }

  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw) >>> 0;
    const address = (val >> 10) & 0x1f;
    const command = (val >> 2) & 0xff;
    return new IRCode({ protocol: this.name, bits: N_BITS, address, subaddress: -1, command, data: val });
  }

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0) & 0x1f;
    const cmd = parseIntVal(args.command ?? args.function ?? 0) & 0xff;
    const data = this.pack(addr, cmd);
    return new IRCode({ protocol: this.name, bits: N_BITS, address: addr, subaddress: -1, command: cmd, data });
  }

  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    // Sharp has no header; bits are mark+space.
    if (burstPairs.length < N_BITS) return null;
    let data = 0;
    for (let i = 0; i < N_BITS; i++) {
      const mark = burstPairs[i][0];
      const space = burstPairs[i][1];
      if (mark < BIT_MARK * 0.5 || mark > BIT_MARK * 1.5) return null;
      let bit: number;
      if (space > (ONE_SPACE + ZERO_SPACE) / 2) bit = 1;
      else if (space < (ONE_SPACE + ZERO_SPACE) / 2 && space > ZERO_SPACE * 0.5) bit = 0;
      else return null;
      data = (data << 1) | bit;
    }
    const address = (data >> 10) & 0x1f;
    const command = (data >> 2) & 0xff;
    return new IRCode({ protocol: this.name, bits: N_BITS, address, subaddress: -1, command, data });
  }

  toPronto(code: IRCode): string {
    const data = (code.data as number) >>> 0;
    const carrierHz = CARRIER;
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);

    const bits: number[] = [];
    for (let i = N_BITS - 1; i >= 0; i--) bits.push((data >> i) & 1);

    const prontoPairs: BurstPair[] = [];
    for (const bit of bits) {
      prontoPairs.push([usToPulses(BIT_MARK), usToPulses(bit ? ONE_SPACE : ZERO_SPACE)]);
    }
    // inverted frame: all bits except address (top 5) inverted
    const addr = (data >> 10) & 0x1f;
    const rest = data & 0x3ff;
    const inverted = (addr << 10) | (~rest & 0x3ff);
    const invBits: number[] = [];
    for (let i = N_BITS - 1; i >= 0; i--) invBits.push((inverted >> i) & 1);
    for (const bit of invBits) {
      prontoPairs.push([usToPulses(BIT_MARK), usToPulses(bit ? ONE_SPACE : ZERO_SPACE)]);
    }

    const seq1 = prontoPairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = prontoPairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
