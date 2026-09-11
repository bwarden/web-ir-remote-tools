// NEC protocol family, ported from IR::Protocol::NEC and its variants.
//
// The single-frame formats differ along two independent axes, both taken
// from the MakeHex IRP files IRDB builds on (nec1.irp, nec2.irp, NECx1.irp,
// NECx2.irp):
//
//   header        NEC1/NEC2 use the full 9024/4512 us preamble
//                 (Prefix=16,-8); NECx1/NECx2 use the half header
//                 4512/4512 us (Prefix=8,-8).
//   subaddress    NEC1/NEC2 expect the subaddress byte to be the one's
//                 complement of the address (Default S=~D); NECx1/NECx2 use
//                 it as the low byte of a real 16-bit address (Default S=D),
//                 so it is never normalized to -1.
//
// NEC2 and NECx2 are timing-identical to NEC1 and NECx1 respectively for a
// single frame; the "2" variants only repeat the *entire* 32-bit frame
// instead of a short header+gap ditto frame, which is invisible to the
// single-frame decoders here. Their protocol name is preserved so repeat
// behavior survives conversion.

import { IRCode, bitReverseBytes, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';

export class NecProtocol implements ProtocolHandler {
  readonly name: string;
  // True for the half-header (4512/4512 us) NECx1/NECx2 framing; false for
  // the full-header (9024/4512 us) NEC1/NEC2 framing.
  halfHeader = false;
  // True when an omitted subaddress means the one's complement of the
  // address (Default S=~D, stored as -1); false when it means "copy the
  // address" (Default S=D, stored as a real byte).
  invertedSubaddressDefault = true;
  // True when a raw subaddress byte equal to ~address is normalized to -1.
  // NEC1/NEC2 treat that byte as redundant; NECx1/NECx2 keep it as part of
  // the 16-bit address.
  normalizeSubaddress = true;

  constructor(name = 'NEC') {
    this.name = name;
  }

  decodeRaw(raw: string | number): IRCode {
    const val = parseIntVal(raw) >>> 0;

    const addr = (val >>> 24) & 0xFF;
    let subaddr = (val >>> 16) & 0xFF;
    const cmd = (val >>> 8) & 0xFF;

    if (this.normalizeSubaddress && subaddr === (~addr & 0xff)) {
      subaddr = -1;
    }

    return new IRCode({
      protocol: this.name,
      bits: 32,
      address: addr,
      subaddress: subaddr,
      command: cmd,
      data: val,
    });
  }

  // NEC's decodeRaw expects the accumulated value (Tasmota DataLSB): the
  // frame bytes are bit-reversed on the wire, so the display form (Tasmota
  // Data) has to be bit-reversed byte by byte to reach the accumulated form.
  decodeByteOrder(raw: string | number, lsb: boolean): IRCode {
    const val = parseIntVal(raw) >>> 0;
    return this.decodeRaw(lsb ? val : bitReverseBytes(val, 32));
  }

  decodeParams(args: DecodeParams): IRCode {
    const addr = parseIntVal(args.address ?? args.device ?? 0);
    const subaddrArg = parseIntVal(args.subaddress ?? args.subdevice ?? -1);
    const cmd = parseIntVal(args.command ?? args.function ?? 0);

    let realSubaddr: number;
    let storedSubaddr: number;
    if (subaddrArg === -1) {
      // Omitted subaddress: derive it from the address per the IRP
      // "Default S=..." rule of this variant.
      if (this.invertedSubaddressDefault) {
        realSubaddr = ~addr & 0xff; // redundant byte, normalized away
        storedSubaddr = -1;
      } else {
        realSubaddr = addr & 0xff;
        storedSubaddr = addr & 0xff;
      }
    } else {
      realSubaddr = subaddrArg & 0xff;
      storedSubaddr = subaddrArg;
    }

    const invCmd = ~cmd & 0xff;

    const data =
      (((addr & 0xff) << 24) | (realSubaddr << 16) | ((cmd & 0xff) << 8) | invCmd) >>> 0;

    return new IRCode({
      protocol: this.name,
      bits: 32,
      address: addr,
      subaddress: storedSubaddr,
      command: cmd,
      data,
    });
  }

  // Decode microsecond timing pairs into an IRCode, or null when the timing
  // signature does not match.
  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    if (burstPairs.length < 34) return null; // Header + 32 bits + Stop

    const [hdrMark, hdrSpace] = burstPairs[0];

    if (this.halfHeader) {
      // NECx1/NECx2 Header Check: ~4500us mark, ~4500us space
      if (!(hdrMark >= 3800 && hdrMark <= 5200 && hdrSpace >= 3800 && hdrSpace <= 5200)) {
        return null;
      }
    } else {
      // NEC1/NEC2 Header Check: ~9000us mark, ~4500us space
      if (!(hdrMark >= 7500 && hdrMark <= 10500 && hdrSpace >= 3500 && hdrSpace <= 5500)) {
        return null;
      }
    }

    const bytes = [0, 0, 0, 0];
    for (let i = 0; i < 32; i++) {
      const space = burstPairs[i + 1][1];
      // Space ~1687us = 1, ~562us = 0
      const bit = space > 1100 ? 1 : 0;
      bytes[i >> 3] |= bit << (i & 7); // LSB-first
    }

    const [addr, subaddrRaw, cmd, invCmd] = bytes as [number, number, number, number];

    // Stop bit: a short mark followed by the long inter-message space. This
    // distinguishes NEC frames from multi-frame captures of other protocols
    // whose header overlaps NEC's (e.g. JVC).
    const [stopMark, stopSpace] = burstPairs[33];
    if (!(stopMark >= 400 && stopMark <= 900 && (stopSpace === 0 || stopSpace >= 3000))) return null;

    const subaddr =
      this.normalizeSubaddress && subaddrRaw === (~addr & 0xff) ? -1 : subaddrRaw;
    const data = ((addr << 24) | (subaddrRaw << 16) | (cmd << 8) | invCmd) >>> 0;

    return new IRCode({
      protocol: this.name,
      bits: 32,
      address: addr,
      subaddress: subaddr,
      command: cmd,
      data,
    });
  }

  toPronto(code: IRCode): string {
    const carrierHz = 38000;

    // The Pronto frequency word is the carrier period in 0.241246 us units,
    // rounded to an integer. Pronto parsers decode pulses using that rounded
    // word (freq_word * 0.241246), and MakeHex converts IRP timings to
    // pulses the same way, so build the pulse conversion period from it.
    // Using the exact 38 kHz period instead would make every pulse count
    // drift by +/-1 from the reference.
    const freqWord = Math.round(1000000.0 / (carrierHz * 0.241246));
    const periodUs = freqWord * 0.241246;
    const usToPulses = (us: number) => Math.round(us / periodUs);

    const addr = code.address & 0xff;
    // A code that reached to_pronto normally carries a real subaddress for
    // the NECx variants, but fall back to the IRP "Default S=..." rule if it
    // is still the -1 sentinel.
    const subaddr =
      code.subaddress !== -1
        ? code.subaddress & 0xff
        : this.invertedSubaddressDefault
          ? ~addr & 0xff
          : addr & 0xff;
    const cmd = code.command & 0xff;
    const invCmd = ~cmd & 0xff;

    const bytes = [addr, subaddr, cmd, invCmd];
    const bits: number[] = [];
    for (const b of bytes) {
      for (let i = 0; i < 8; i++) bits.push((b >> i) & 1);
    }

    const [hdrMarkUs, hdrSpaceUs] = this.halfHeader
      ? [4512, 4512] // NECx1/NECx2: Prefix=8,-8  (8*564, 8*564)
      : [9024, 4512]; // NEC1/NEC2:   Prefix=16,-8 (16*564, 8*564)

    const burstPairs: BurstPair[] = [[usToPulses(hdrMarkUs), usToPulses(hdrSpaceUs)]];
    for (const bit of bits) {
      burstPairs.push([usToPulses(562.5), usToPulses(bit ? 1687.5 : 562.5)]);
    }

    // Suffix=1,-78: a 564 us stop mark and the inter-message space
    // (78*564 = ~44 ms), matching the MakeHex reference output.
    burstPairs.push([usToPulses(564), usToPulses(43992)]);

    const seq1 = burstPairs.length;
    const header = `0000 ${toHex(freqWord, 4)} ${toHex(seq1, 4)} 0000`;
    const payload = burstPairs.map((p) => `${toHex(p[0], 4)} ${toHex(p[1], 4)}`).join(' ');
    return `${header} ${payload}`;
  }
}

export class Nec2Protocol extends NecProtocol {
  constructor() {
    super('NEC2');
  }
}

export class Necx1Protocol extends NecProtocol {
  constructor() {
    super('NECX1');
    this.halfHeader = true;
    this.invertedSubaddressDefault = false;
    this.normalizeSubaddress = false;
  }
}

export class Necx2Protocol extends NecProtocol {
  constructor() {
    super('NECX2');
    this.halfHeader = true;
    this.invertedSubaddressDefault = false;
    this.normalizeSubaddress = false;
  }
}
