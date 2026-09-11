// 48-NEC1 / 48-NEC2 protocol handlers (48-bit NEC family), from the
// DecodeIR definitions:
//
//   48-NEC1: {38.0k,564}<1,-1|1,-3>(16,-8,D:8,S:8,F:8,~F:8,E:8,~E:8,1,^108m,(16,-4,1,^108m)*)
//   48-NEC2: {38.0k,564}<1,-1|1,-3>(16,-8,D:8,S:8,F:8,~F:8,E:8,~E:8,1,^108m)+
//
// As with the 32-bit NEC family, the "2" variant only differs in repeat
// behavior (whole-frame repeat instead of a ditto mark), which is invisible
// to the single-frame decoders here; the name is preserved so repeat
// behavior survives conversion. The trailing E byte is not part of the
// IRDB CSV rows, so it defaults to 0 when a code is built from
// device/subdevice/function parameters.

import { IRCode, bitReverseBytes, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

const BITS = 48;
const HDR_MARK = 9000;
const HDR_SPACE = 4500;
const BIT_MARK = 560;
const ONE_SPACE = 1690;
const ZERO_SPACE = 560;
const STOP_MARK = 560;

function encodeData(addr: number, subaddr: number, cmd: number, ext: number): number {
  const d = addr & 0xff;
  const s = subaddr & 0xff;
  const f = cmd & 0xff;
  const e = ext & 0xff;
  return d * 2 ** 40 + s * 2 ** 32 + f * 2 ** 24 + ((~f) & 0xff) * 2 ** 16 + e * 2 ** 8 + ((~e) & 0xff);
}

export class Nec48Protocol implements ProtocolHandler {
  constructor(readonly name: '48-NEC1' | '48-NEC2') {}

  // The frame bytes are each sent LSB-first, so the accumulated value
  // (Tasmota DataLSB) is what decodeRaw reads.
  readonly lsbIsAccumulated = true;

  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw);
    return new IRCode({
      protocol: this.name,
      bits: BITS,
      address: Math.floor(val / 2 ** 40) & 0xff,
      subaddress: Math.floor(val / 2 ** 32) & 0xff,
      command: Math.floor(val / 2 ** 24) & 0xff,
      data: val,
    });
  }

  decodeByteOrder(raw: string | number, lsb: boolean): IRCode {
    const val = parseIntVal(raw);
    return this.decodeRaw(lsb ? val : bitReverseBytes(val, BITS));
  }

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0) & 0xff;
    const subaddr = parseIntVal(args.subaddress ?? args.subdevice ?? -1) & 0xff;
    const cmd = parseIntVal(args.command ?? args.function ?? 0) & 0xff;

    // The E byte is not part of the IRDB rows; send it cleared.
    return new IRCode({
      protocol: this.name,
      bits: BITS,
      address: addr,
      subaddress: subaddr,
      command: cmd,
      data: encodeData(addr, subaddr, cmd, 0),
    });
  }

  // Decode microsecond timing pairs into an IRCode, or null when the timing
  // signature does not match. A single frame is 1 header + 48 bits + 1 stop
  // burst pair; the IRP's trailing `+`/`*` repeats that whole frame.
  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    if (burstPairs.length < 50) return null; // Header + 48 bits + Stop

    const [hdrMark, hdrSpace] = burstPairs[0];

    // NEC Header Check: ~9000us mark, ~4500us space.
    if (!(hdrMark >= 7500 && hdrMark <= 10500 && hdrSpace >= 3500 && hdrSpace <= 5500)) {
      return null;
    }

    const bytes = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 48; i++) {
      const space = burstPairs[i + 1][1];
      // Space ~1690us = 1, ~560us = 0
      const bit = space > 1100 ? 1 : 0;
      bytes[i >> 3] |= bit << (i & 7); // LSB-first
    }

    // Stop bit: a short mark followed by the ~108ms inter-frame space. A
    // capture may end on a bare trailing mark with no space.
    const [stopMark, stopSpace] = burstPairs[49];
    if (!(stopMark >= 400 && stopMark <= 900 && (stopSpace === 0 || stopSpace >= 3000))) {
      return null;
    }

    const [b0, b1, b2, b3, b4, b5] = bytes as [number, number, number, number, number, number];
    const data =
      b0 * 2 ** 40 + b1 * 2 ** 32 + b2 * 2 ** 24 + b3 * 2 ** 16 + b4 * 2 ** 8 + b5;

    return new IRCode({
      protocol: this.name,
      bits: BITS,
      address: b0,
      subaddress: b1,
      command: b2,
      data,
    });
  }

  toPronto(code: IRCode): string {
    const carrierHz = 38000;
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);

    const addr = code.address & 0xff;
    const subaddr = code.subaddress === -1 ? 0 : code.subaddress & 0xff;
    const cmd = code.command & 0xff;
    const e = typeof code.data === 'number' ? Math.floor(code.data / 2 ** 8) & 0xff : 0;
    const bytes = [addr, subaddr, cmd, (~cmd) & 0xff, e, (~e) & 0xff];

    const bits: number[] = [];
    for (const b of bytes) {
      for (let i = 0; i < 8; i++) bits.push((b >> i) & 1);
    }

    const burstPairs: BurstPair[] = [[usToPulses(HDR_MARK), usToPulses(HDR_SPACE)]];
    for (const bit of bits) {
      burstPairs.push([usToPulses(BIT_MARK), usToPulses(bit ? ONE_SPACE : ZERO_SPACE)]);
    }

    burstPairs.push([usToPulses(STOP_MARK), usToPulses(108000)]);

    const seq1 = burstPairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = burstPairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
