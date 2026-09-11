// SAMSUNG20 protocol handler (20-bit), from the MakeHex Samsung20.irp and
// DecodeIR definitions:
//
//   {38.4k,564}<1,-1|1,-3>(8,-8,D:6,S:6,F:8,1,-44)
//
// A 20-bit frame carries a 6-bit device, a 6-bit subdevice, and an 8-bit
// function, transmitted LSB-first within each field behind a 4512/4512 us
// header (the same header Samsung's 32-bit protocol uses). IRDB uses it for
// Samsung air-conditioner handsets.

import { IRCode, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

const BITS = 20;
const HDR_MARK = 4512;
const HDR_SPACE = 4512;
const BIT_MARK = 564;
const ONE_SPACE = 1692;
const ZERO_SPACE = 564;
const STOP_MARK = 564;
const STOP_SPACE = 24816; // 44 x 564us

// Pack device/subdevice/function into the transmitted 20-bit word. The
// default subdevice is 0 per Samsung20.irp (Default S=0), so a caller that
// omits it (DecodeParams.subaddress === -1) sends a zero field.
function encodeData(addr: number, subaddr: number, cmd: number): number {
  return ((cmd & 0xff) << 12) | ((subaddr & 0x3f) << 6) | (addr & 0x3f);
}

export class Samsung20Protocol implements ProtocolHandler {
  readonly name = 'SAMSUNG20';

  readonly lsbIsAccumulated = true;

  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw);
    return new IRCode({
      protocol: this.name,
      bits: BITS,
      address: val & 0x3f,
      subaddress: (val >> 6) & 0x3f,
      command: (val >> 12) & 0xff,
      data: val,
    });
  }

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0) & 0x3f;
    const subaddrArg = parseIntVal(args.subaddress ?? args.subdevice ?? -1);
    const cmd = parseIntVal(args.command ?? args.function ?? 0) & 0xff;
    const subaddr = subaddrArg === -1 ? 0 : subaddrArg & 0x3f;

    return new IRCode({
      protocol: this.name,
      bits: BITS,
      address: addr,
      subaddress: subaddrArg,
      command: cmd,
      data: encodeData(addr, subaddr, cmd),
    });
  }

  // Decode microsecond timing pairs into an IRCode, or null when the timing
  // signature does not match. The IRP sends the whole frame once (no
  // repeat), so a capture is 1 header + 20 bits + 1 stop burst pair.
  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    if (burstPairs.length < 22) return null; // Header + 20 bits + Stop

    const [hdrMark, hdrSpace] = burstPairs[0];

    // SAMSUNG20 Header Check: ~4512us mark, ~4512us space.
    if (!(hdrMark >= 3800 && hdrMark <= 5200 && hdrSpace >= 3800 && hdrSpace <= 5200)) {
      return null;
    }

    let value = 0;
    for (let i = 0; i < 20; i++) {
      const space = burstPairs[i + 1][1];
      // Space ~1692us = 1, ~564us = 0
      const bit = space > 1100 ? 1 : 0;
      value += bit * 2 ** i; // LSB-first
    }

    // Stop bit: a short mark followed by the ~25ms inter-frame space. A
    // capture may end on a bare trailing mark with no space.
    const [stopMark, stopSpace] = burstPairs[21];
    if (!(stopMark >= 400 && stopMark <= 900 && (stopSpace === 0 || stopSpace >= 3000))) {
      return null;
    }

    return new IRCode({
      protocol: this.name,
      bits: BITS,
      address: value & 0x3f,
      subaddress: (value >> 6) & 0x3f,
      command: (value >> 12) & 0xff,
      data: value,
    });
  }

  toPronto(code: IRCode): string {
    const carrierHz = 38400;
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);

    const addr = code.address & 0x3f;
    const subaddr = code.subaddress === -1 ? 0 : code.subaddress & 0x3f;
    const cmd = code.command & 0xff;
    const data = encodeData(addr, subaddr, cmd);

    const bits: number[] = [];
    for (let i = 0; i < 20; i++) bits.push((data >> i) & 1); // LSB-first

    const burstPairs: BurstPair[] = [[usToPulses(HDR_MARK), usToPulses(HDR_SPACE)]];
    for (const bit of bits) {
      burstPairs.push([usToPulses(BIT_MARK), usToPulses(bit ? ONE_SPACE : ZERO_SPACE)]);
    }

    burstPairs.push([usToPulses(STOP_MARK), usToPulses(STOP_SPACE)]);

    const seq1 = burstPairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = burstPairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}
