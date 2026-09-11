// IRDB CSV importer, ported from IR::Format::CSV.

import { IRCode } from '../code.js';
import type { Converter } from '../converter.js';

// Quote a CSV field only when it needs it (commas, quotes, newlines).
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
  return value;
}

// Parse a single CSV line with quoted value support. The unquoted field
// whitespace is trimmed, matching the Perl regex-based parser. Exported so the
// indexer can reuse the same parsing to explain why a file produced no codes.
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      inQuotes = true;
      quoted = true;
    } else if (c === ',') {
      fields.push(quoted ? field : field.trim());
      field = '';
      quoted = false;
    } else {
      field += c;
    }
  }
  fields.push(quoted ? field : field.trim());
  return fields;
}

// Normalize protocol aliases commonly found in IRDB.
//
// IRDB labels its NEC-family rows NEC, NEC1, nec, nec1 (all the standard
// NEC1 framing), NEC2 (whole-frame repeat), and NECx1/NECx2 (the extended,
// half-header 16-bit-address variants). Anything else is returned
// uppercased, so unknown protocols still reach the registry and are skipped
// as unregistered rather than being silently remapped.
//
// A few per-brand NEC and JVC labels are also mapped onto their base
// protocol. In every case the address/subaddress/command bytes are laid out
// exactly as the base protocol, so a captured base-protocol signal decodes to
// the same device/subdevice/command and the index keys agree:
//
//   -F16 (Onkyo/Integra, LiteTouch) sends F instead of ~F in the fourth byte
//   -Y1/-Y2/-Y3 (Yamaha) put F XORed with a fixed value there
//   -rnc leaves the repeat frame's function uncomplemented
//   JVC{2} is JVC without the lead-in, with identical device/OBC bytes
//
// The wider-frame labels (JVC-48, 48-NEC1/48-NEC2, Samsung20) are NOT mapped:
// they carry different bit widths, so their device/function columns do not
// line up with the base protocol's framing. They are returned uppercased and
// decode through their own registered handlers.
function normalizeProtocol(proto: string | undefined): string {
  if (proto === undefined || proto === null) return '';
  const p = proto.trim().toUpperCase();

  if (/^NEC1?(-F16|-Y[123]|-RNC)?$/.test(p)) return 'NEC';
  if (p === 'NEC2' || p === 'NEC2-F16') return 'NEC2';
  if (p === 'NECX1' || p === 'NECX1-F16') return 'NECX1';
  if (p === 'NECX2' || p === 'NECX2-F16') return 'NECX2';
  if (p === 'JVC' || p === 'JVC{2}') return 'JVC';
  return p;
}

export class CsvFormat {
  // Export codes as an IRDB-style button listing. IRDB stores one row per
  // button as functionname,protocol,device,subdevice,function with decimal
  // address/subaddress/command (the current repository format; a raw-data
  // column is not part of it). Rows the IRDB format cannot express — raw
  // bypass signals with no protocol identity — are skipped. The device
  // (address) and command come straight from the code, so importing the file
  // back reconstructs the same values.
  export(codes: IRCode | IRCode[], _converter: Converter): string {
    const list = Array.isArray(codes) ? codes : [codes];
    const rows = list
      .filter((c) => !c.bypassProtocol)
      .map((c) => ({
        alias: csvField(c.alias ?? ''),
        protocol: csvField(c.protocol),
        address: String(c.address),
        subaddress: String(c.subaddress === undefined ? -1 : c.subaddress),
        command: c.command,
      }));
    rows.sort((a, b) => a.command - b.command);
    const fields = rows.map((r) => [r.alias, r.protocol, r.address, r.subaddress, String(r.command)].join(','));
    const header = 'functionname,protocol,device,subdevice,function';
    if (!fields.length) return header + '\n';
    return [header, ...fields].join('\n') + '\n';
  }

  decode(input: string, converter: Converter): IRCode[] {
    if (input === undefined || input === null) throw new Error('No CSV input provided');

    let lines = String(input).split(/\r?\n/);
    lines = lines.filter((l) => /\S/.test(l));
    if (!lines.length) throw new Error('CSV input is empty');

    // The first line is usually the header row, but a few IRDB files ship
    // without one (the first line is already a button) or join the first two
    // header names with a tab ("functionname\tprotocol,..."). Parse the line,
    // splitting embedded tabs, then only treat it as a header when it names
    // at least one known column.
    const headerTokens = parseCsvLine(lines[0])
      .flatMap((h) => h.split('\t'))
      .map((h) => h.toLowerCase().replace(/^\uFEFF/, ''));

    // Map column headers.
    const colMap: Record<string, number> = {};
    let recognized = 0;
    for (let i = 0; i < headerTokens.length; i++) {
      const h = headerTokens[i].trim();

      if (/^(functionname|function_name|key|alias|label|name)$/.test(h)) {
        colMap.alias = i;
        recognized++;
      } else if (/^(protocol|proto)$/.test(h)) {
        colMap.protocol = i;
        recognized++;
      } else if (/^(device|address|addr|dev)$/.test(h)) {
        colMap.device = i;
        recognized++;
      } else if (/^(subdevice|subaddress|subaddr|subdev)$/.test(h)) {
        colMap.subdevice = i;
        recognized++;
      } else if (/^(function|command|cmd|code)$/.test(h) && colMap.alias === undefined) {
        colMap.command = i;
        recognized++;
      } else if (/^(function|command|cmd|code)$/.test(h)) {
        colMap.command = colMap.command ?? i;
        recognized++;
      } else if (/^(data|hex|raw)$/.test(h)) {
        colMap.data = i;
        recognized++;
      }
    }

    if (recognized === 0) {
      // No known column names, so the header row is missing and the first
      // line is a button. Fall back to the standard IRDB column order
      // (functionname, protocol, device, subdevice, function) and leave the
      // first line in place to be read as data.
      colMap.alias = 0;
      colMap.protocol = 1;
      colMap.device = 2;
      colMap.subdevice = 3;
      colMap.command = 4;
    } else {
      lines.shift(); // consume the real header row
    }

    const decoded: IRCode[] = [];

    for (const line of lines) {
      const fields = parseCsvLine(line);
      if (!fields.length) continue;

      const proto = colMap.protocol !== undefined ? normalizeProtocol(fields[colMap.protocol]) : '';
      if (!proto) continue;

      const alias = colMap.alias !== undefined ? fields[colMap.alias] : 'UNKNOWN';
      const device = colMap.device !== undefined ? fields[colMap.device] : undefined;
      const subdevice = colMap.subdevice !== undefined ? fields[colMap.subdevice] : undefined;
      const command = colMap.command !== undefined ? fields[colMap.command] : undefined;
      const data = colMap.data !== undefined ? fields[colMap.data] : undefined;

      // Rows with an unregistered protocol or an unparseable value are
      // skipped (as documented in the Perl POD), not fatal: real IRDB files
      // routinely mix protocols this distribution does not handle.
      let irCode: IRCode | undefined;
      try {
        if (data !== undefined && data !== '') {
          irCode = converter.importCode(proto, data);
        } else if (device !== undefined && command !== undefined) {
          irCode = converter.importCode(proto, {
            device,
            subdevice: subdevice ?? -1,
            command,
          });
        }
      } catch {
        // skip row
      }

      if (irCode) {
        irCode.alias = alias;
        decoded.push(irCode);
      }
    }

    return decoded;
  }
}
