// Regression: LIRC NEC import must preserve the NEC byte-order so that
// LIRC, wig, and CodesCSV produce identical IRCodes for the same signal.
// Vizio N/A 32-bit NEC KEY_POWER from the real fixture. On the wire NEC1
// transmits each byte LSB-first, so decoder data is accumulated; import
// from ANY source must land at the byte-order same to digest.
//
// Ground truth (the same Vizio NEC Power signal through the converter's own
// diagnostic, Pronto-identical every source):
//
//   LIRC KEY_POWER 0x10EF (pre_data 0x20DF): decodes accumulated 0x20DF10EF
//   wig  Power     ...:                     decodes display  0x04FB08F7
//
// See test/fixtures/irdb-nec-receiver.csv row for Vizio: 4,-1,8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Converter } from '../src/lib/converter.js';

const converter = new Converter();
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

function loadLirc(name: string) {
  return converter.importFormat('LIRC', readFileSync(join(fixtures, name), 'utf8'));
}

function loadWig(name: string) {
  return converter.importFormat('wig', readFileSync(join(fixtures, name), 'utf8'));
}

function loadCodesCsv(name: string) {
  return converter.importFormat('CodesCSV', readFileSync(join(fixtures, name), 'utf8'));
}

test('LIRC NEC Vizio KEY_POWER imports byte-order-identical to wig NEC', () => {
  const lirc = loadLirc('lirc-vizio-LCD_TV.lircd.conf').find((c) => c.alias === 'KEY_POWER')!;
  const wig = loadWig('vizio.wig.json').find((c) => c.alias === 'Power')!;

  assert.ok(lirc, 'KEY_POWER from LIRC');
  assert.ok(wig, 'Power from wig');
  assert.equal(lirc.protocol, 'NEC', 'LIRC NEC protocol');
  assert.equal(wig.protocol, 'NEC', 'wig NEC protocol');
  assert.equal(lirc.protocol, wig.protocol, 'protocols agree');

  assert.equal(lirc.bits, 32, '32-bit NEC');
  assert.equal(wig.bits, 32, 'wig 32-bit NEC');
  assert.equal(lirc.bits, wig.bits, 'bits agree');

  // The frame is NEC display data 0x04FB08F7 (address 4, command 8). Both
  // imports must agree in the DISPLAY (accumulated byte-order normalised
  // IRDB) convention; 0x20DF10EF is the per-byte bit-reversed accumulated
  // form and must never survive as address/command.
  assert.equal(lirc.data, 0x04FB08F7, 'LIRC data is the display form');
  assert.equal(wig.data, 0x04FB08F7, 'wig data is the display form');
  assert.equal(lirc.address, 4, 'LIRC address 4');
  assert.equal(wig.address, 4, 'wig address 4');
  assert.equal(lirc.address, wig.address, 'addresses agree');
  assert.equal(lirc.subaddress, wig.subaddress, 'subaddresses agree');
  assert.equal(lirc.command, 8, 'LIRC command 8');
  assert.equal(wig.command, 8, 'wig command 8');
  assert.equal(lirc.command, wig.command, 'commands agree');
});
