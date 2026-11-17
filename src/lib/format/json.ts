// JSON IR database import, ported to sit alongside the wig importer. The
// format is JSON: one document per remote with a "commands" list, each
// command being:
//
//   {
//     "keycode": "G:Memorex 32 Bit:()(0xC100E01F)():3",
//     "name": "AmFmToggle",
//     "pronto": "0000 006D ...",
//     "protocol": "Memorex 32 Bit"
//   }
//
// The signal payload is raw Pronto hex, exactly as a HAIR wig carries, so
// this format imports to the same IRCode list a wig would.  The wig importer
// auto-detects this shape, so the two formats interchange freely at the
// converter entry point.  Import-only: the opaque "keycode"/"protocol"
// strings are the dump's own naming, so we never re-export this format.
import { IRCode } from '../code.js';
import type { Converter } from '../converter.js';

export class JsonFormat {
  // Parse a JSON IR database document into IRCode objects.
  // Validation is all-or-nothing and field-level, mirroring the wig
  // importer: every problem is reported at once with a "commands[i].field"
    // reason and a malformed file is rejected wholesale. Commands that carry
    // no Pronto payload (a compact export may list buttons it never captured
    // a signal for) are skipped rather than failing the import.
  decode(input: unknown, converter: Converter): IRCode[] {
    if (input === undefined || input === null) throw new Error('No JSON input provided');

    let text = String(input);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Strip UTF-8 BOM

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`json: not valid JSON (${(e as Error).message})`);
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('json: top level must be a JSON object');
    }

    const doc = data as Record<string, unknown>;
    const reasons: string[] = [];

    const commands = doc.commands;
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
      throw new Error(`json failed validation:\n${reasons.join('\n')}`);
    }

    // The repeat count is a device property (timing.pressMinRepeats), not a
    // property of an individual command or its keycode; the keycode's trailing
    // ":N" is a constant on 99.95% of keycodes and is not a repeat count.
    const repeatCount = jsonRepeatCount(doc);

    const decoded: IRCode[] = [];
    for (const cmd of commands as unknown[]) {
      const command = cmd as Record<string, unknown>;
      if (typeof command.pronto !== 'string' || command.pronto.trim() === '') continue;
      const code = converter.importFormat('Pronto', command.pronto)[0];
      code.alias = command.name as string;
      code.sendCount = repeatCount;
      decoded.push(code);
    }
    return decoded;
  }
}

// The repeat count of a JSON document: how many times the whole code replays
// upon transmission. In the IR database this is the device's
// timing.pressMinRepeats (the Harmony hub reads it, defaulting to 3). It is
// a property of the device, not of an individual command or its keycode.
// 0 means no count was recorded, which the wig exporter reads as the default
// single press.
function jsonRepeatCount(doc: Record<string, unknown>): number {
  const timing = doc.timing;
  if (timing && typeof timing === 'object' && !Array.isArray(timing)) {
    const t = timing as Record<string, unknown>;
    const pmr = t.pressMinRepeats;
    if (typeof pmr === 'number' && Number.isInteger(pmr) && pmr >= 0) return pmr;
    if (typeof pmr === 'string' && /^\d+$/.test(pmr)) return Number.parseInt(pmr, 10);
    return 3; // Harmony hub default when the field is absent
  }
  if (typeof doc.pressMinRepeats === 'number' && Number.isInteger(doc.pressMinRepeats) && doc.pressMinRepeats >= 0) {
    return doc.pressMinRepeats;
  }
  if (typeof doc.pressMinRepeats === 'string' && /^\d+$/.test(doc.pressMinRepeats)) {
    return Number.parseInt(doc.pressMinRepeats, 10);
  }
  return 0;
}
