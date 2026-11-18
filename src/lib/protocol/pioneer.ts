import { IRCode, parseIntBig, parseIntVal, toHex } from '../code.js';
import type { BurstPair, DecodeParams, ProtocolHandler } from '../protocol.js';
import { NecProtocol } from './nec.js';

const nec = new NecProtocol('NEC');

export class PioneerProtocol implements ProtocolHandler {
  readonly name = 'Pioneer';

  decodeRaw(raw: string | number | bigint): IRCode {
    const val = BigInt(parseIntBig(raw));
    const first = Number((val >> 32n) & 0xffffffffn);
    const second = Number(val & 0xffffffffn);
    const firstCode = nec.decodeRaw(first);
    const secondCode = nec.decodeRaw(second);
    const address = (firstCode.data !== undefined ? (firstCode.data as number) >> 8 : 0) & 0xff;
    const command = (secondCode.data !== undefined ? (secondCode.data as number) >> 8 : 0) & 0xff;
    return new IRCode({ protocol: this.name, bits: 64, address, subaddress: -1, command, data: val });
  }

  decodeParams(args: DecodeParams): IRCode {
    const address = parseIntVal(args.address ?? args.device ?? 0) & 0xff;
    const command = parseIntVal(args.command ?? args.function ?? 0) & 0xff;
    const first = nec.decodeParams({ address: 0, command: address });
    const second = nec.decodeParams({ address: 0, command: command });
    const data = (BigInt(first.data as number) << 32n) | BigInt(second.data as number);
    return new IRCode({ protocol: this.name, bits: 64, address, subaddress: -1, command, data });
  }

  decodeTiming(burstPairs: BurstPair[]): IRCode | null {
    if (burstPairs.length < 68) return null;
    const first = nec.decodeTiming(burstPairs.slice(0, 34));
    if (!first) return null;
    const second = nec.decodeTiming(burstPairs.slice(34, 68));
    if (!second) return null;
    const address = ((first.data as number) >> 8) & 0xff;
    const command = ((second.data as number) >> 8) & 0xff;
    const data = (BigInt(first.data as number) << 32n) | BigInt(second.data as number);
    return new IRCode({ protocol: this.name, bits: 64, address, subaddress: -1, command, data });
  }

  toPronto(code: IRCode): string {
    const data = BigInt(parseIntBig(code.data));
    const first = Number((data >> 32n) & 0xffffffffn);
    const second = Number(data & 0xffffffffn);
    const firstCode = nec.decodeRaw(first);
    const secondCode = nec.decodeRaw(second);
    const p1 = nec.toPronto(firstCode);
    const p2 = nec.toPronto(secondCode);
    // Combine: reuse frequency from p1, concatenate burst pairs
    const tokens1 = p1.trim().split(/\s+/);
    const tokens2 = p2.trim().split(/\s+/);
    const freqWord = tokens1[1];
    const pairs1Count = parseInt(tokens1[2], 16);
    const pairs2Count = parseInt(tokens2[2], 16);
    const totalPairs = pairs1Count + pairs2Count;
    const header = `0000 ${freqWord} ${toHex(totalPairs, 4)} 0000`;
    const payload1 = tokens1.slice(4).join(' ');
    const payload2 = tokens2.slice(4).join(' ');
    return `${header} ${payload1} ${payload2}`;
  }
}
