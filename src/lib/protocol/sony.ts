import { IRCode, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

// Sony SIRC: 12/15/20 bit, 40 kHz carrier. Header 2400/600 us, bit marks
// 1200 (one) / 600 (zero), space 600 us, LSB-first on the wire.

function reverseBits(value: number, bits: number): number {
  let out = 0;
  for (let i = 0; i < bits; i++) {
    if ((value >> i) & 1) out |= 1 << (bits - 1 - i);
  }
  return out >>> 0;
}

export class SonyProtocol implements ProtocolHandler {
  readonly name: string;
  readonly bits: number;
  readonly addressBits: number;
  readonly extendedBits: number;

  constructor(name: string, bits: number) {
    this.name = name;
    this.bits = bits;
    if (bits === 12) { this.addressBits = 5; this.extendedBits = 0; }
    else if (bits === 15) { this.addressBits = 8; this.extendedBits = 0; }
    else { this.addressBits = 5; this.extendedBits = 8; }
  }

  private logicalValue(addr: number, ext: number, cmd: number): number {
    let v = addr & ((1 << this.addressBits) - 1);
    if (this.extendedBits) v |= (ext & ((1 << this.extendedBits) - 1)) << this.addressBits;
    v = (v << 7) | (cmd & 0x7f);
    return v;
  }

  decodeRaw(raw: string | number): IRCode {
    const transmitted = parseIntVal(raw) >>> 0;
    const logical = reverseBits(transmitted, this.bits);
    const cmd = logical & 0x7f;
    const addr = (logical >> 7) & ((1 << this.addressBits) - 1);
    let ext = 0;
    if (this.extendedBits) ext = (logical >> (7 + this.addressBits)) & ((1 << this.extendedBits) - 1);
    return new IRCode({
      protocol: this.name,
      bits: this.bits,
      address: addr,
      subaddress: this.extendedBits ? ext : -1,
      command: cmd,
      data: logical,
    });
  }

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0);
    const ext = parseIntVal(args.subaddress ?? args.subdevice ?? 0);
    const cmd = parseIntVal(args.command ?? args.function ?? 0);
    const logical = this.logicalValue(addr, ext, cmd);
    return new IRCode({
      protocol: this.name,
      bits: this.bits,
      address: addr,
      subaddress: this.extendedBits ? ext : -1,
      command: cmd,
      data: logical,
    });
  }

  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    const [hdrMark, hdrSpace] = burstPairs[0];
    if (!(hdrMark >= 2000 && hdrMark <= 2800 && hdrSpace >= 400 && hdrSpace <= 800)) return null;

    if (burstPairs.length < this.bits + 1) return null;
    // Reject frames carrying more bits than this variant.
    if (burstPairs.length > this.bits + 1 && (burstPairs[this.bits + 1][0] ?? 0) !== 0) return null;
    let data = 0;
    for (let k = 0; k < this.bits; k++) {
      const mark = burstPairs[k + 1][0];
      let bit: number;
      if (mark >= 1000 && mark <= 1400) bit = 1;
      else if (mark >= 400 && mark <= 800) bit = 0;
      else return null;
      data = (data << 1) | bit;
    }

    const logical = reverseBits(data, this.bits);
    const cmd = logical & 0x7f;
    const addr = (logical >> 7) & ((1 << this.addressBits) - 1);
    let ext = 0;
    if (this.extendedBits) ext = (logical >> (7 + this.addressBits)) & ((1 << this.extendedBits) - 1);

    return new IRCode({
      protocol: this.name,
      bits: this.bits,
      address: addr,
      subaddress: this.extendedBits ? ext : -1,
      command: cmd,
      data: logical,
    });
  }

  toPronto(code: IRCode): string {
    const carrierHz = 40000;
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);

    const addr = code.address & ((1 << this.addressBits) - 1);
    const ext = this.extendedBits ? (code.subaddress & ((1 << this.extendedBits) - 1)) : 0;
    const cmd = code.command & 0x7f;
    const logical = this.logicalValue(addr, ext, cmd);
    const transmitted = reverseBits(logical, this.bits);

    const bits: number[] = [];
    for (let i = this.bits - 1; i >= 0; i--) bits.push((transmitted >> i) & 1);

    const pairs: BurstPair[] = [[usToPulses(2400), usToPulses(600)]];
    for (const bit of bits) {
      pairs.push([usToPulses(bit ? 1200 : 600), usToPulses(600)]);
    }

    const seq1 = pairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = pairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
