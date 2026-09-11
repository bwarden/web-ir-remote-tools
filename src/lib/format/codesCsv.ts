// Sample "IR Remote Control Codes" CSV importer.
//
// The tables in ./samples ("IR Remote Control Codes - <PROTO>.csv") describe
// one protocol per file with a two-row header: a grouping row that labels the
// decimal and hex column pairs, then the real column-name row. For example
// the NEC file starts:
//
//   ,,Decimal,,,Hex,,,,,,,
//   Code,LSB,Device,Subdevice,Function,Device,Function,Width,Product,Key,...
//   0xFF52AD,0x00FF4AB5,0,-1,74,0x0,0x4A,32,Capello DVD,Power,...
//
// Column meanings, resolved by name (case-insensitive, duplicates allowed):
//
//   LSB       the accumulated data word (each transmitted byte is read
//             LSB-first, so the display form and the received form are
//             per-byte bit reversals). This is the value the code decoders
//             read directly - the same byte order as Tasmota DataLSB.
//   Code      the per-byte bit-reversed reading of the same frame (Tasmota
//             Data). Never fed to decodeRaw directly.
//   Address / Addr / Device / Dev     the address (numeric).
//   Subaddress / Subaddr / Subdevice  the subaddress.
//   Function                          the function number.
//   Command     the function number when there is no Function column
//               (Samsung36); otherwise the button name (JVC).
//   Key / Name / Label / Alias        the button name.
//   Product / Model (or a non-numeric Device column)  the device type.
//   Width       the bit width.
//
// NEC and JVC files have both numeric and hex column pairs (e.g. Device,
// Subdevice, Function twice), where the second member of a pair is often the
// only one filled in. A value is always taken from the first non-empty cell
// across the matching columns, in header order.
//
// Rows are decoded through the registered protocol's byte-order entry point
// (LSB column through importLsb, Code column through importMsb), so the
// decoded address/subaddress/command match the numeric columns of the table.
// SAMSUNG36 (registered alongside NEC/JVC/SAMSUNG) reads the Code column
// MSB-first and its LSB column is the same word reversed end to end, which
// its decodeByteOrder translates. Protocols with no registered handler are
// built from the numeric columns directly - the codes stay usable for IRDB
// lookup and display, but carry no timing until a protocol handler exists.

import { IRCode, bitReverseBytes, parseIntVal } from '../code.js';
import type { Converter } from '../converter.js';

export interface CodesCsvInput {
  protocol: string;
  text: string;
  // Restrict the returned codes to rows whose device-type column equals this
  // value. Omit to import every row.
  device?: string;
}

// Parse a single CSV line with quoted value support, matching the IRDB CSV
// parser.
function parseCsvLine(line: string): string[] {
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

// A grouping row labels the column pairs ("Decimal", "Hex") and holds no data
// or column names.
function isGroupingRow(cells: string[]): boolean {
  return cells.every((c) => c === '' || /^(decimal|hex|binary)$/i.test(c));
}

const ADDR_NAMES = /^(address|addr|device|dev)$/;
const SUBADDR_NAMES = /^(subaddress|subaddr|subdevice|subdev)$/;
const FUNC_NAMES = /^(function|fn)$/;
const CMD_NAMES = /^(command|cmd)$/;
const ALIAS_NAMES = /^(key|name|label|alias)$/;
const PRODUCT_NAMES = /^(product|model)$/;

function isHexLike(v: string): boolean {
  return /^0x/i.test(v);
}

// "Numeric" means a plain integer or a 0x-prefixed hex value, as opposed to
// the free-text device-type names.
function isNumericCell(v: string): boolean {
  return v !== '' && (isHexLike(v) || /^-?\d+$/.test(v));
}

// Reverse the full `bits`-bit value end to end (not per byte). Some formats
// report the whole data word reversed rather than each byte, so the display
// form has to be rebuilt that way when only the received form is present.
// Uses arithmetic, not bitwise operators, so words wider than 32 bits are not
// truncated. Each `out * 2 + bit` step shifts earlier bits up, so feeding the
// original bits LSB-first builds the reversed word MSB-first.
function reverseBits(value: number, bits: number): number {
  let out = 0;
  for (let i = 0; i < bits; i++) {
    out = out * 2 + (Math.floor(value / 2 ** i) % 2);
  }
  return out;
}

interface ColumnMap {
  lsb: number[];
  code: number[];
  addr: number[];
  sub: number[];
  func: number[];
  cmd: number[];
  alias: number[];
  product: number[];
  width: number[];
}

function buildColumnMap(header: string[]): ColumnMap {
  const map: ColumnMap = {
    lsb: [],
    code: [],
    addr: [],
    sub: [],
    func: [],
    cmd: [],
    alias: [],
    product: [],
    width: [],
  };
  header.forEach((h, i) => {
    const name = h.trim().replace(/^\uFEFF/, '').toLowerCase();
    if (name === 'lsb') map.lsb.push(i);
    else if (name === 'code') map.code.push(i);
    else if (ADDR_NAMES.test(name)) map.addr.push(i);
    else if (SUBADDR_NAMES.test(name)) map.sub.push(i);
    else if (FUNC_NAMES.test(name)) map.func.push(i);
    else if (CMD_NAMES.test(name)) map.cmd.push(i);
    else if (ALIAS_NAMES.test(name)) map.alias.push(i);
    else if (PRODUCT_NAMES.test(name)) map.product.push(i);
    else if (name === 'width') map.width.push(i);
  });
  return map;
}

function firstValue(fields: string[], cols: number[]): string {
  for (const c of cols) {
    if (fields[c] !== undefined && fields[c] !== '') return fields[c];
  }
  return '';
}

// The device-type column: an explicit Product/Model column, otherwise the
// first Device/Address column whose content is not numeric (Samsung36 puts
// "Samsung Bluray" in a Device column while Address holds the numbers).
function deviceColumn(map: ColumnMap, dataRows: string[][]): number {
  if (map.product.length > 0) return map.product[0];
  for (const c of map.addr) {
    if (dataRows.some((r) => r[c] !== undefined && r[c] !== '' && !isNumericCell(r[c]))) {
      return c;
    }
  }
  return -1;
}

// The button-name column: Key/Name/Label/Alias; otherwise, when the table has
// a Function column, the Command column holds the button name (JVC).
function aliasColumn(map: ColumnMap): number[] {
  if (map.alias.length > 0) return map.alias;
  if (map.func.length > 0 && map.cmd.length > 0) return map.cmd;
  return [];
}

// The function-number column: Function; otherwise Command.
function commandColumn(map: ColumnMap): number[] {
  if (map.func.length > 0) return map.func;
  return map.cmd;
}

export class CodesCsvFormat {
  decode(input: unknown, converter: Converter): IRCode[] {
    if (input === undefined || input === null) throw new Error('No Codes CSV input provided');
    const isObj = typeof input === 'object';
    const text = String(isObj ? (input as CodesCsvInput).text : input);
    const protocol = isObj ? (input as CodesCsvInput).protocol : '';
    const deviceFilter = isObj ? (input as CodesCsvInput).device : undefined;

    if (!protocol) throw new Error('Codes CSV import needs a protocol (from the sample file name)');
    const protoName = protocol.trim().toUpperCase();
    const proto = converter.getProtocol(protoName);

    const lines = text.split(/\r?\n/).filter((l) => /\S/.test(l));
    if (!lines.length) throw new Error('Codes CSV input is empty');

    let headerIdx = 0;
    if (isGroupingRow(parseCsvLine(lines[0]))) headerIdx = 1;
    const map = buildColumnMap(parseCsvLine(lines[headerIdx]));
    const dataRows = lines
      .slice(headerIdx + 1)
      .map((l) => parseCsvLine(l))
      .filter((r) => r.length > 0);

    const deviceCol = deviceColumn(map, dataRows);
    const aliasCols = aliasColumn(map);
    const cmdCols = commandColumn(map);

    const decoded: IRCode[] = [];

    for (const fields of dataRows) {
      const device = deviceCol >= 0 ? fields[deviceCol] ?? '' : '';
      if (deviceFilter !== undefined && device !== deviceFilter) continue;

      const alias = firstValue(fields, aliasCols) || 'UNKNOWN';

      // A value from the numeric columns is authoritative for rows the code
      // decoders cannot express (e.g. SAMSUNG36's 20-bit command).
      const addrText = firstValue(fields, map.addr);
      const subText = firstValue(fields, map.sub);
      const cmdText = firstValue(fields, cmdCols);
      const hasParams =
        addrText !== '' && isNumericCell(addrText) && (cmdText === '' || isNumericCell(cmdText));

      let irCode: IRCode | undefined;

      if (proto) {
        const lsb = firstValue(fields, map.lsb);
        const code = firstValue(fields, map.code);
        try {
          if (lsb !== '') {
            irCode = converter.importLsb(protoName, lsb);
          } else if (code !== '') {
            irCode = converter.importMsb(protoName, code);
          } else if (hasParams) {
            irCode = converter.importCode(protoName, {
              address: addrText,
              subaddress: subText === '' ? -1 : subText,
              command: cmdText === '' ? 0 : cmdText,
            });
          }
        } catch {
          irCode = undefined;
        }
      } else if (hasParams) {
        // No registered handler (SAMSUNG36): build the code from the table.
        // The data word is only meaningful when the display (Code) column is
        // present; otherwise reconstruct it from the received (LSB) form.
        const code = firstValue(fields, map.code);
        const lsb = firstValue(fields, map.lsb);
        const width = firstValue(fields, map.width);
        const bits = width !== '' ? parseIntVal(width) : 0;
        let data: number | undefined;
        if (code !== '') data = parseIntVal(code);
        else if (lsb !== '') data = bits ? reverseBits(parseIntVal(lsb), bits) : undefined;
        irCode = new IRCode({
          protocol: protoName,
          bits,
          address: parseIntVal(addrText),
          subaddress: subText === '' ? -1 : parseIntVal(subText),
          command: cmdText === '' ? 0 : parseIntVal(cmdText),
          data,
        });
      }

      if (irCode) {
        irCode.alias = alias;
        // The device-type column (brand/model, e.g. "VCR", "JVC RM-SMXKA6J")
        // is the code's device identity; keep it so a wig populated from a
        // code table can name the remote it came from.
        if (device !== '') irCode.device = device;
        decoded.push(irCode);
      }
    }

    return decoded;
  }
}
