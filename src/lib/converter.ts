// Converter - registry and manager for IR code protocols and formats.
//
// TypeScript port of IR::Converter. Every code is normalized into an IRCode
// object, so a signal decoded from one format can be encoded into any other.
//
// Protocols are registered in the order Pronto/Tasmota/wig decoding tries
// them. Handlers whose timing signatures overlap must be ordered so the most
// likely interpretation wins, because the timing decoders cannot tell them
// apart:
//
//   NEC before NEC2 - a single NEC2 frame is timing-identical to a NEC1
//   frame (the "2" variants only differ in repeat structure), so NEC, the
//   far more common framing, absorbs NEC2 frames on a timing decode. NEC2
//   stays registered so codes imported by name (IRDB CSV) keep the NEC2
//   identity. The 48-NEC1/48-NEC2 pair mirrors this, and both are tried
//   after the 32-bit NEC family: they share the 9000/4500 us header but the
//   extra 16 data bits fail the 32-bit stop-bit check, so 48-bit frames only
//   reach them.
//
//   JVC before JVC-48 before PANASONIC - JVC-48 and Panasonic both use the
//   same per-byte LSB-first framing with a 3456/1728 us header and 48 data
//   bits; the 32-bit JVC decoder rejects their headers, so the longer frame
//   falls through. JVC-48 (OEM 3/1) and Panasonic (OEM 0x40/0x04) are
//   distinguished by their OEM bytes and checksum validation, so the more
//   common JVC-48 is tried first.
//
//   SAMSUNG before NECX1/NECX2 - NECx frames use Samsung's 4500/4500 us half
//   header, so the two families share a header and bit timing. A single-frame
//   NECx1/NECx2 capture is therefore only distinguished from SAMSUNG by the
//   Samsung byte structure (address repeated, command followed by its
//   complement) that SAMSUNG's strict decoder enforces and NECx frames lack
//   (they carry a subaddress byte). The NECx decoder that follows is then the
//   one that matches, so NECx frames keep their NECx1/NECX2 identity on a
//   timing decode. (IRremoteESP8266 has no NECx decoder and reports the same
//   capture as UNKNOWN; ours names the protocol it recognizes.)
//
//   SAMSUNG before SAMSUNG36 - both use the 4500/4500 us header, but SAMSUNG
//   rejects the 36-bit framing (its stop-bit check needs a >= 3000 us space
//   where SAMSUNG36 has a mid-frame data bit), so SAMSUNG36 is tried after it
//   and only matches when SAMSUNG declines. SAMSUNG20 is registered after
//   them but shares neither their length (a lone 20-bit frame is 22 bursts,
//   far below their 34/38-burst minimum) nor SAMSUNG36's framing, so it
//   never shadows or is shadowed by the 32/36-bit decoders.
//
//   MWM is registered last: it is the catch-all for the headerless MWM signal.
//   Its width matcher accepts a bare 417 us run as a 1-tick mark or space, so
//   it must never run before a decoder with a real header signature. It
//   cannot steal frames from any of the registered protocols, because the
//   header marks they all carry (NEC 9000, Samsung/NECx 4500, JVC 8400, JVC-48
//   3456, SAMSUNG36 4500) match no whole number of 417 us ticks and get
//   rejected at the first level, and a frame that reaches it intact must also
//   pass the MWM body signature: state[0] carries a 0x9x/0xFx command nibble
//   or the message opens with the 0x55 0xAA show-command header.

import { IRCode } from './code.js';
import type { DecodeParams, ProtocolHandler } from './protocol.js';
import { NecProtocol, Nec2Protocol, Necx1Protocol, Necx2Protocol } from './protocol/nec.js';
import { Nec48Protocol } from './protocol/nec48.js';
import { MwmProtocol } from './protocol/mwm.js';
import { JvcProtocol } from './protocol/jvc.js';
import { Jvc48Protocol } from './protocol/jvc48.js';
import { PanasonicProtocol } from './protocol/panasonic.js';
import { SamsungProtocol } from './protocol/samsung.js';
import { Samsung36Protocol } from './protocol/samsung36.js';
import { Samsung20Protocol } from './protocol/samsung20.js';
import { ProntoFormat } from './format/pronto.js';
import { CsvFormat } from './format/csv.js';
import { CodesCsvFormat } from './format/codesCsv.js';
import { WigFormat } from './format/wig.js';
import { GcFormat } from './format/gc.js';
import { TasmotaFormat } from './format/tasmota.js';
import { Mode2Format } from './format/mode2.js';
import { LircFormat } from './format/lirc.js';

export type CodeInput = string | number | DecodeParams;

export interface FormatHandler {
  export?(codes: IRCode | IRCode[], converter: Converter, opts?: unknown): string;
  decode?(input: unknown, converter: Converter): IRCode[];
}

export class Converter {
  private protocols: Record<string, ProtocolHandler> = {};
  private protocolOrder: string[] = [];
  private formats: Record<string, FormatHandler> = {};

  constructor() {
    this.registerProtocol(new NecProtocol('NEC'));
    this.registerProtocol(new Nec2Protocol());
    this.registerProtocol(new Nec48Protocol('48-NEC1'));
    this.registerProtocol(new Nec48Protocol('48-NEC2'));
    this.registerProtocol(new JvcProtocol());
    this.registerProtocol(new Jvc48Protocol());
    this.registerProtocol(new PanasonicProtocol());
    this.registerProtocol(new SamsungProtocol());
    this.registerProtocol(new Samsung36Protocol());
    this.registerProtocol(new Samsung20Protocol());
    this.registerProtocol(new Necx1Protocol());
    this.registerProtocol(new Necx2Protocol());
    this.registerProtocol(new MwmProtocol());

    this.registerFormat('Pronto', new ProntoFormat());
    this.registerFormat('CSV', new CsvFormat());
    this.registerFormat('CodesCSV', new CodesCsvFormat());
    this.registerFormat('WIG', new WigFormat());
    this.registerFormat('Tasmota', new TasmotaFormat());
    this.registerFormat('Mode2', new Mode2Format());
    this.registerFormat('LIRC', new LircFormat());
    const gc = new GcFormat();
    this.registerFormat('GCIR', gc);
    this.registerFormat('GlobalCache', gc);
  }

  registerProtocol(handler: ProtocolHandler): void {
    const key = handler.name.toUpperCase();
    this.protocols[key] = handler;
    if (!this.protocolOrder.includes(key)) this.protocolOrder.push(key);
  }

  registerFormat(name: string, handler: FormatHandler): void {
    this.formats[name.toUpperCase()] = handler;
  }

  getProtocol(name: string): ProtocolHandler | undefined {
    return this.protocols[name.toUpperCase()];
  }

  // Registered protocols in deterministic registration order.
  getProtocols(): ProtocolHandler[] {
    return this.protocolOrder.map((k) => this.protocols[k]);
  }

  importCode(protocol: string, input: CodeInput): IRCode {
    const proto = this.getProtocol(protocol);
    if (!proto) throw new Error(`Unsupported protocol: ${protocol}`);

    if (input !== null && typeof input === 'object') {
      return proto.decodeParams(input as DecodeParams);
    }
    return proto.decodeRaw(input as string | number);
  }

  // Import a transmitted frame value in a named byte order. `lsb` selects the
  // accumulated form (Tasmota DataLSB, the IRRemoteESP8266 value, the "LSB"
  // column of the sample code tables); the default is the display form
  // (Tasmota Data, the "Code"/"MSB" column). Protocols with a byte-order
  // distinction translate so the decoded address/subaddress/command always
  // matches the transmitted bytes; protocols without one decode the value
  // as-is.
  private importByteOrder(protocol: string, input: string | number, lsb: boolean): IRCode {
    const proto = this.getProtocol(protocol);
    if (!proto) throw new Error(`Unsupported protocol: ${protocol}`);
    if (typeof proto.decodeByteOrder === 'function') {
      return proto.decodeByteOrder(input, lsb);
    }
    return proto.decodeRaw(input as string | number);
  }

  // Import from the accumulated value (Tasmota DataLSB / IRRemoteESP8266
  // value / the "LSB" column of the sample code tables).
  importLsb(protocol: string, input: string | number): IRCode {
    return this.importByteOrder(protocol, input, true);
  }

  // Import from the display value (Tasmota Data / the "Code" column).
  importMsb(protocol: string, input: string | number): IRCode {
    return this.importByteOrder(protocol, input, false);
  }

  exportCode(code: IRCode, format: string, opts?: unknown): string {
    const fmt = this.formats[format.toUpperCase()];
    if (!fmt) throw new Error(`Unsupported format: ${format}`);
    if (!fmt.export) throw new Error(`Format ${format} does not support export`);
    return fmt.export(code, this, opts);
  }

  exportCodes(format: string, codes: IRCode[], opts?: unknown): string {
    const fmt = this.formats[format.toUpperCase()];
    if (!fmt) throw new Error(`Unsupported format: ${format}`);
    if (!fmt.export) throw new Error(`Format ${format} does not support export`);
    return fmt.export(codes, this, opts);
  }

  importFormat(format: string, input: unknown): IRCode[] {
    const fmt = this.formats[format.toUpperCase()];
    if (!fmt) throw new Error(`Unsupported format: ${format}`);
    if (!fmt.decode) throw new Error(`Format ${format} does not support import`);
    return fmt.decode(input, this);
  }
}
