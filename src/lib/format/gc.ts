// Global Caché IR database JSON import, ported to sit alongside the wig
// importer.  Global Caché hardware ("iTach", "GC-100" line) exports its IR
// code database as one JSON document per remote with a "commands" list; each
// command is:
//
//   {
//     "keycode": "G:Memorex 32 Bit:()(0xC100E01F)():3",
//     "name": "AmFmToggle",
//     "pronto": "0000 006D ...",
//     "protocol": "Memorex 32 Bit"
//   }
//
// The signal payload is raw Pronto hex, exactly as a HAIR wig carries, so a
// GC export imports to the same IRCode list a wig would.  The wig importer
// auto-detects this shape, so the two formats interchange freely at the
// converter entry point.  Import-only: the opaque "keycode"/"protocol"
// strings are Global Caché's own naming, so we never re-export this format.
import { IRCode } from '../code.js';
import type { Converter } from '../converter.js';

export class GcFormat {
  // Parse a Global Caché IR database JSON string into IRCode objects.
  // Validation is all-or-nothing and field-level, mirroring the wig
  // importer: every problem is reported at once with a "commands[i].field"
    // reason and a malformed file is rejected wholesale. Commands that carry
    // no Pronto payload (a compact export may list buttons it never captured
    // a signal for) are skipped rather than failing the import.
  decode(input: unknown, converter: Converter): IRCode[] {
    if (input === undefined || input === null) throw new Error('No GC input provided');

    let text = String(input);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Strip UTF-8 BOM

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`gc: not valid JSON (${(e as Error).message})`);
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('gc: top level must be a JSON object');
    }

    const gc = data as Record<string, unknown>;
    const reasons: string[] = [];

    const commands = gc.commands;
    if (commands === undefined) {
      reasons.push('commands: required');
    } else if (!Array.isArray(commands)) {
      reasons.push('commands: must be a list');
    } else if (commands.length === 0) {
      reasons.push('commands: must not be empty');
    }

    if (Array.isArray(commands)) {
      commands.forEach((cmd, i) => {
        if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
          reasons.push(`commands[${i}]: must be an object`);
          return;
        }
        const command = cmd as Record<string, unknown>;

        if (typeof command.name !== 'string' || command.name === '') {
          reasons.push(`commands[${i}].name: required`);
        }

        // A compact export may list commands without a Pronto payload (no
        // signal captured for them); nothing to convert, so skip rather than
        // fail the whole import.
        if (typeof command.pronto !== 'string' || command.pronto.trim() === '') return;

        try {
          converter.importFormat('Pronto', command.pronto);
        } catch (e) {
          reasons.push(`commands[${i}].pronto: ${(e as Error).message}`);
        }
      });
    }

    if (reasons.length) {
      throw new Error(`gc failed validation:\n${reasons.join('\n')}`);
    }

    const decoded: IRCode[] = [];
    for (const cmd of commands as unknown[]) {
      const command = cmd as Record<string, unknown>;
      if (typeof command.pronto !== 'string' || command.pronto.trim() === '') continue;
      const code = converter.importFormat('Pronto', command.pronto)[0];
      code.alias = command.name as string;
      decoded.push(code);
    }
    return decoded;
  }
}