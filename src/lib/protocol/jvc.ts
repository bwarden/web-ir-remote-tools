// JVC protocol handler (16-bit), ported from IR::Protocol::JVC.

import { IRCode, bitReverseBytes, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

export class JvcProtocol implements ProtocolHandler {
  readonly name = 'JVC';

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0);
    const cmd = parseIntVal(args.command ?? args.function ?? 0);

    const data = ((addr & 0xff) << 8) | (cmd & 0xff);

    return new IRCode({
      protocol: this.name,
      bits: 16,
      address: addr,
      subaddress: -1,
      command: cmd,
      data,
    });
  }

  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw) >>> 0;
    const addr = (val >>> 8) & 0xff;
    const cmd = val & 0xff;

    return new IRCode({
      protocol: this.name,
      bits: 16,
      address: addr,
      subaddress: -1,
      command: cmd,
      data: val,
    });
  }

  // JVC's decodeRaw expects the accumulated value (Tasmota DataLSB): the
  // frame bytes are bit-reversed on the wire, so the display form (Tasmota
  // Data) has to be bit-reversed byte by byte to reach the accumulated form.
  decodeByteOrder(raw: string | number, lsb: boolean): IRCode {
    const val = parseIntVal(raw) >>> 0;
    return this.decodeRaw(lsb ? val : bitReverseBytes(val, 16));
  }

  // Decode microsecond timing pairs into an IRCode, or null when the timing
  // signature does not match.
  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    if (burstPairs.length < 18) return null; // Header + 16 bits + Stop

    const [hdrMark, hdrSpace] = burstPairs[0];

    // JVC Header Check: ~8400us mark, ~4200us space
    if (!(hdrMark >= 7000 && hdrMark <= 9800 && hdrSpace >= 3200 && hdrSpace <= 5200)) {
      return null;
    }

    const bytes = [0, 0];
    for (let i = 0; i < 16; i++) {
      const space = burstPairs[i + 1][1];
      // Space ~1578us = 1, ~526us = 0
      const bit = space > 1000 ? 1 : 0;
      bytes[i >> 3] |= bit << (i & 7); // LSB-first
    }

    const [addr, cmd] = bytes as [number, number];
    const data = (addr << 8) | cmd;

    // Stop bit: a short mark followed by the inter-frame gap (~17080us for
    // repeated frames, ~42000us for a lone frame). Single-frame captures may
    // end on a bare trailing mark with no space. This rejects signals whose
    // header overlaps JVC's but have a different frame structure.
    const [stopMark, stopSpace] = burstPairs[17];
    if (!(stopMark >= 400 && stopMark <= 900 && (stopSpace === 0 || stopSpace >= 8000))) {
      return null;
    }

    return new IRCode({
      protocol: this.name,
      bits: 16,
      address: addr,
      subaddress: -1,
      command: cmd,
      data,
    });
  }

  toPronto(code: IRCode): string {
    const carrierHz = 38000;
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);

    const burstPairs: BurstPair[] = [[usToPulses(8400), usToPulses(4200)]];

    const bits: number[] = [];
    for (let i = 0; i < 8; i++) bits.push((code.address >> i) & 1);
    for (let i = 0; i < 8; i++) bits.push((code.command >> i) & 1);

    for (const bit of bits) {
      burstPairs.push([usToPulses(526), usToPulses(bit ? 1578 : 526)]);
    }

    burstPairs.push([usToPulses(526), usToPulses(42000)]);

    const seq1 = burstPairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = burstPairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
