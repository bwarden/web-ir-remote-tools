//
// Vizio VX37L NEC (REVERSE flag) — byte-order regression.
//
// The SAME Vizio VX37L TV key is recorded in two places: IRDB carries the
// display form (NEC,4,-1,8 for KEY_POWER, 0x04FB08F7) and the lirc-remotes
// vizio/VX37L conf stores each 16-bit word bit-mirrored (REVERSE flag):
// pre_data 0xFB04 / Power 0xF708 instead of LCD_TV's non-reverse
// pre_data 0x20DF / Power 0x10EF. The REVERSE words are the same signal
// written backwards, so the LIRC import must mirror each word back to the
// wire's accumulated order, then reduce to the identical display form — and
// export byte-for-byte identical Pronto to IRDB.
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
const loadIrdb = (name: string) => converter.importFormat('CSV', readFileSync(join(samples, name), 'utf8'));

// The four buttons present in both files, with their IRDB address/command.
const BUTTONS: Array<[alias: string, command: number]> = [
  ['KEY_POWER', 8],
  ['KEY_MUTE', 9],
  ['KEY_VOLUMEDOWN', 3],
  ['KEY_VOLUMEUP', 2],
];

const EXPECTED = (command: number) => ({
  protocol: 'NEC',
  bits: 32,
  address: 4,
  subaddress: -1,
  command,
  data: (0x04fb0000 | (command << 8) | (~command & 0xff)) >>> 0,
});

test('LIRC REVERSE VX37L KEY_POWER decodes to 4,-1,8 (0x04FB08F7), not 223,-1,239', () => {
  const power = loadLirc('lirc-vizio-VX37L.lircd.conf').find((c) => c.alias === 'KEY_POWER');
  assert.ok(power, 'KEY_POWER imported from LIRC');
  assert.deepEqual(
    { protocol: power.protocol, bits: power.bits, address: power.address, subaddress: power.subaddress, command: power.command, data: power.data },
    EXPECTED(8),
    'REVERSE words are mirrored and reduced to the display form',
  );
});

test('LIRC VX37L decodes the same NEC address 4 / command 8 signal as IRDB', () => {
  const lirc = loadLirc('lirc-vizio-VX37L.lircd.conf');
  const irdb = loadIrdb('irdb-vizio-Unknown_VX37L-4,-1.csv');

  for (const [alias, command] of BUTTONS) {
    const l = lirc.find((c) => c.alias === alias);
    const i = irdb.find((c) => c.alias === alias);
    assert.ok(l, `LIRC ${alias}`);
    assert.ok(i, `IRDB ${alias}`);
    assert.deepEqual(
      { protocol: l.protocol, bits: l.bits, address: l.address, subaddress: l.subaddress, command: l.command, data: l.data },
      EXPECTED(command),
      `LIRC ${alias} matches the IRDB display form`,
    );
    assert.equal(l.protocol, i.protocol, `${alias} protocol agrees`);
    assert.equal(l.address, i.address, `${alias} address agrees`);
    assert.equal(l.subaddress, i.subaddress, `${alias} subaddress agrees`);
    assert.equal(l.command, i.command, `${alias} command agrees`);
    assert.equal(l.data, i.data, `${alias} data agrees`);
  }
});

test('LIRC VX37L exports Pronto identical to IRDB for the shared keys', () => {
  const lirc = loadLirc('lirc-vizio-VX37L.lircd.conf');
  const irdb = loadIrdb('irdb-vizio-Unknown_VX37L-4,-1.csv');
  const pronto = (code: IRCode) => converter.exportCode(code, 'Pronto').trim();

  for (const [alias] of BUTTONS) {
    const l = lirc.find((c) => c.alias === alias)!;
    const i = irdb.find((c) => c.alias === alias)!;
    assert.equal(pronto(l), pronto(i), `Pronto for ${alias} is identical`);
  }
});

test('LIRC VX37L REVERSE and LCD_TV (non-REVERSE) describe the same NEC power signal', () => {
  const reverse = loadLirc('lirc-vizio-VX37L.lircd.conf').find((c) => c.alias === 'KEY_POWER')!;
  const plain = loadLirc('lirc-vizio-LCD_TV.lircd.conf').find((c) => c.alias === 'KEY_POWER')!;
  assert.equal(reverse.data, plain.data, 'both land on the same display form');
  assert.equal(reverse.address, plain.address, 'same address');
  assert.equal(reverse.command, plain.command, 'same command');
});