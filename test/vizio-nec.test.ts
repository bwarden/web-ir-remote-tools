//
// Vizio N/A NEC Power — byte-order regression.
//
// The SAME Vizio NEC Power signal (once, the real Pronto) is imported from
// three formats. LIRC NEC KEY_POWER traditionally came in accumulated form
// (pre_data 0x20DF, value 0x10EF, full 0x20DF10EF, address=32 command=16),
// while WIG and CodesCSV decode the identical signal to display form
// (address=4 subaddress=-1 command=8, data 0x04FB08F7). All NEC sources
// MUST converge on the display form and export identical Tasmota/Pronto.
//
// Ground truth from samples/: lirc-vizio-LCD_TV.lircd.conf (KEY_POWER,
// pre_data 0x20DF value 0x10EF), vizio.wig.json (Power), and
// irdb-vizio-Unknown_Vizio-4,-1.csv (NEC,4,-1,8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Converter } from '../src/lib/converter.js';
import type { IRCode } from '../src/lib/code.js';

const converter = new Converter();
const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, '..', 'samples');

const loadLirc = (name: string) => converter.importFormat('LIRC', readFileSync(join(samples, name), 'utf8'));
const loadWig = (name: string) => converter.importFormat('WIG', readFileSync(join(samples, name), 'utf8'));
const loadIrdb = (name: string) => converter.importFormat('CSV', readFileSync(join(samples, name), 'utf8'));

test('LIRC NEC KEY_POWER decodes Vizio Power to 4,-1,8 (0x04FB08F7), not 32,-1,16', () => {
  const power = loadLirc('lirc-vizio-LCD_TV.lircd.conf').find((c) => c.alias === 'KEY_POWER');
  assert.ok(power, 'KEY_POWER imported from LIRC');
  assert.equal(power.protocol, 'NEC');
  assert.equal(power.bits, 32);
  assert.equal(power.address, 4);
  assert.equal(power.subaddress, -1);
  assert.equal(power.command, 8);
  assert.equal(power.data, 0x04FB08F7);
});

test('LIRC/IDB/WIG NEC Power exports identical Tasmota and Pronto', () => {
  const lirc = loadLirc('lirc-vizio-LCD_TV.lircd.conf').find((c) => c.alias === 'KEY_POWER');
  const wig = loadWig('vizio.wig.json').find((c) => c.alias === 'Power');
  const irdb = loadIrdb('irdb-vizio-Unknown_Vizio-4,-1.csv').find((c) => c.alias === 'KEY_POWER');
  assert.ok(lirc, 'LIRC KEY_POWER');
  assert.ok(wig, 'WIG KEY_POWER');
  assert.ok(irdb, 'IRDB KEY_POWER');

  const tasmota = (code: IRCode) => converter.exportCode(code, 'Tasmota').trim();
  const pronto = (code: IRCode) => converter.exportCode(code, 'Pronto').trim();
  assert.equal(tasmota(lirc), tasmota(wig));
  assert.equal(tasmota(wig), tasmota(irdb));
  assert.equal(pronto(lirc), pronto(wig));
  assert.equal(pronto(wig), pronto(irdb));
});
