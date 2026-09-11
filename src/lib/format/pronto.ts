// Raw Pronto Hex encoder and decoder, ported from IR::Format::Pronto.

import { IRCode } from '../code.js';
import type { BurstPair } from '../protocol.js';
import type { Converter } from '../converter.js';

export interface ExportOptions {
  [key: string]: unknown;
}

export class ProntoFormat {
  export(codes: IRCode | IRCode[], converter: Converter): string {
    const list = Array.isArray(codes) ? codes : [codes];
    return list
      .map((code) => {
        const plugin = converter.getProtocol(code.protocol);
        if (!plugin) throw new Error(`No protocol encoder registered for: ${code.protocol}`);
        return plugin.toPronto(code);
      })
      .join('\n');
  }

  // Parses a Pronto Hex string into microsecond mark/space pairs and tries
  // each registered protocol's decodeTiming in registration order. Returns
  // the first matching IRCode, or throws if the string cannot be decoded.
  decode(prontoStr: string, converter: Converter): IRCode[] {
    if (prontoStr === undefined || prontoStr === null) {
      throw new Error('No Pronto Hex string provided');
    }

    const str = prontoStr.trim();
    const tokens = str.split(/\s+/);

    if (tokens.length < 4) throw new Error('Invalid Pronto Hex string (too short)');

    if (parseInt(tokens[0], 16) !== 0) {
      throw new Error('Only raw Pronto Hex format (0000) is supported');
    }

    const freqWord = parseInt(tokens[1], 16);
    const seq1Pairs = parseInt(tokens[2], 16);
    const seq2Pairs = parseInt(tokens[3], 16);

    // Calculate carrier frequency and period in microseconds.
    const carrierHz = freqWord > 0 ? Math.trunc(1000000.0 / (freqWord * 0.241246)) : 38000;
    const periodUs = 1000000.0 / carrierHz;

    const burstPairs: BurstPair[] = [];
    const pairCount = seq1Pairs + seq2Pairs;

    for (let i = 0; i < pairCount; i++) {
      const idx = 4 + i * 2;
      if (idx + 1 >= tokens.length) break;

      const markCycles = parseInt(tokens[idx], 16);
      const spaceCycles = parseInt(tokens[idx + 1], 16);

      burstPairs.push([markCycles * periodUs, spaceCycles * periodUs]);
    }

    // Iterate over registered protocols (in registration order) to decode
    // the timing array.
    for (const proto of converter.getProtocols()) {
      const dec = proto as { decodeTiming?: (p: BurstPair[]) => IRCode | null };
      if (typeof dec.decodeTiming === 'function') {
        const code = dec.decodeTiming(burstPairs);
        if (code) return [code];
      }
    }

    throw new Error('Unable to decode Pronto Hex string into a known protocol');
  }
}
