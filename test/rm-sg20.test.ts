//
// RM-SG20 NEC — cross-format byte-order, value, and timing consistency.
//
// The same NEC signal (32-bit, address 131 = 0x83, subaddress 0) exists in
// three formats under samples/rm-sg20/ and must import to one identical code:
//
//  131,0.csv               IRDB row (functionname,protocol,device,subdevice,
//                          function) — command via decimal numeric columns.
//  RM-SG20.lircd.conf      WinLIRC/Sony remote, bits 16, pre_data 0xC100 with
//                          codes-section 16-bit values (e.g. KEY_POWER 0x00FF).
//  b0c3d8e523722ae5.json   a "Memorex 32 Bit" (= NEC) capture whose per-button
//                          Pronto Hex is embedded below. The json itself is
//                          NOT committed; only the hex it carries is.
//
// NEC transmits every byte LSB-first, so the receiver's accumulated word
// (Tasmota "Data", the json keycode value) is the per-byte bit reversal of the
// display form (Tasmota "DataLSB", our IRCode.data). pre_data 0xC100 + value
// 0xXXXX packs 0xC100XXXX in accumulated order; the display form is
// 0x8300XXXX (address 131, subaddress 0). All three importers must land on the
// same display form, and re-exporting to Tasmota (Data + DataLSB) and Pronto
// (its timing words) must give identical strings from every source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Converter } from '../src/lib/converter.js';
import { bitReverseBytes } from '../src/lib/code.js';

const converter = new Converter();
const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, '..', 'samples', 'rm-sg20');

const loadIrdb = () => converter.importFormat('CSV', readFileSync(join(samples, '131,0.csv'), 'utf8'));
const loadLirc = () =>
  converter.importFormat('LIRC', readFileSync(join(samples, 'RM-SG20.lircd.conf'), 'utf8'));

const ADDR = 0x83; // 131
const BASE = (ADDR << 24) | (0 << 16); // display bytes: address, subaddress 0

// The NEC display word for address 131/subaddress 0: command byte, its one's
// complement in the fourth byte.
const displayFor = (cmd: number) => (BASE | ((cmd & 0xff) << 8) | (~cmd & 0xff)) >>> 0;

interface Button {
  name: string; // label for failure messages
  alias: string; // alias used by the IRDB CSV and the LIRC conf
  capture: string; // button name in the json capture
  command: number; // IRDB function column and LIRC/Pronto decoded command
  accumulated: number; // the json keycode value (Tasmota Data / LSB-receiver word)
  pronto: string; // Pronto Hex embedded from the (uncommitted) json capture
}

const buttons: Button[] = [
  {
    name: 'Power',
    alias: 'KEY_POWER',
    capture: 'PowerToggle',
    command: 0,
    accumulated: 0xc10000ff,
    pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
  },
  {
    name: 'Volume Up',
    alias: 'KEY_VOLUMEUP',
    capture: 'VolumeUp',
    command: 2,
    accumulated: 0xc10040bf,
    pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
  },
  {
    name: 'Volume Down',
    alias: 'KEY_VOLUMEDOWN',
    capture: 'VolumeDown',
    command: 3,
    accumulated: 0xc100c03f,
    pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
  },
  {
    name: 'Tape',
    alias: 'KEY_TAPE',
    capture: 'InputTape2',
    command: 5,
    accumulated: 0xc100a05f,
    pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
  },
  {
    name: 'Band',
    alias: 'Band',
    capture: 'AmFmToggle',
    command: 7,
    accumulated: 0xc100e01f,
    pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
  },
  {
    name: 'Phono',
    alias: 'Phono',
    capture: 'InputPhono',
    command: 11,
    accumulated: 0xc100d02f,
    pronto: `0000 006D 0022 0000 0156 00AB 0017 003D 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 003D 0017 0013 0017 003D 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 0013 0017 003D 0017 0013 0017 003D 0017 003D 0017 003D 0017 003D 0017 0663`,
  },
];

const NEC_PRONTO_HEAD = '0000 006D 0022 0000'; // 38 kHz, 34 burst pairs

for (const btn of buttons) {
  test(`RM-SG20 ${btn.name}: IRDB/LIRC/Pronto agree on NEC fields, data, datalsb`, () => {
    const irdb = loadIrdb().find((c) => c.alias === btn.alias);
    const lirc = loadLirc().find((c) => c.alias === btn.alias);
    const pronto = converter.importFormat('Pronto', btn.pronto).pop()!;
    assert.ok(irdb, `IRDB row ${btn.alias}`);
    assert.ok(lirc, `LIRC button ${btn.alias}`);
    assert.ok(pronto, 'Pronto decodes to a code');

    const display = displayFor(btn.command);
    const datalsb = bitReverseBytes(display, 32);

    for (const [src, code] of [
      ['IRDB', irdb],
      ['LIRC', lirc],
      ['Pronto', pronto],
    ] as const) {
      assert.equal(code.protocol, 'NEC', `${src} protocol`);
      assert.equal(code.bits, 32, `${src} bits`);
      assert.equal(code.address, ADDR, `${src} address`);
      assert.equal(code.subaddress, 0, `${src} sub-address`);
      assert.equal(code.command, btn.command, `${src} command`);
      assert.equal(code.data, display, `${src} data (display form)`);
      assert.equal(bitReverseBytes(code.data as number, code.bits), datalsb, `${src} datalsb`);
      assert.equal(datalsb, btn.accumulated, `${src} datalsb equals the capture's accumulated word`);
    }

    // Converting every source to Tasmota JSON emits the identical Data/DataLSB
    // pair, and converting to Pronto emits the identical timing encoding.
    const tasmota = (c: typeof irdb) => converter.exportCode(c, 'Tasmota', { style: 'json' }).trim();
    const taskTxt = tasmota(irdb);
    assert.equal(tasmota(lirc), taskTxt, 'Tasmota export: IRDB == LIRC');
    assert.equal(tasmota(pronto), taskTxt, 'Tasmota export: IRDB == Pronto');
    assert.match(taskTxt, new RegExp(`"Data":"0x${btn.accumulated.toString(16).toUpperCase().padStart(8, '0')}"`));
    assert.match(taskTxt, new RegExp(`"DataLSB":"0x${display.toString(16).toUpperCase().padStart(8, '0')}"`));

    const prontoOut = (c: typeof irdb) => converter.exportCode(c, 'Pronto').trim();
    const prTxt = prontoOut(irdb);
    assert.equal(prontoOut(lirc), prTxt, 'Pronto export: IRDB == LIRC');
    assert.equal(prontoOut(pronto), prTxt, 'Pronto export: IRDB == Pronto');
    assert.match(prTxt, /^0000 006D 0022 0000 /, 'Pronto export keeps the 38 kHz / 34-pair NEC framing');

    // The Pronto round-trip is stable: exporting and re-importing preserves
    // every field, so the timings encode the same code from every source.
    const round = converter.importFormat('Pronto', prTxt).pop()!;
    assert.equal(round.address, ADDR);
    assert.equal(round.subaddress, 0);
    assert.equal(round.command, btn.command);
    assert.equal(round.data, display);
  });
}

// The Global Caché json export is present only in local checkouts (its hex is
// carried as literals above so a clean clone stays hermetic); when it is
// here, the new GCIR importer must parse it in place of the embedded hex.
const gcPath = join(samples, 'b0c3d8e523722ae5.json');
test('RM-SG20 GC json imports in place of the embedded hex', { skip: !existsSync(gcPath) }, () => {
  const viaGc = converter.importFormat('GCIR', readFileSync(gcPath, 'utf8'));
  const viaWig = converter.importFormat('WIG', readFileSync(gcPath, 'utf8'));
  assert.deepEqual(viaWig, viaGc, 'WIG entry point imports the GC export interchangeably');

  for (const btn of buttons) {
    const code = viaGc.find((c) => c.alias === btn.capture);
    assert.ok(code, `GC import has ${btn.capture}`);
    assert.equal(code.protocol, 'NEC', `${btn.capture} protocol`);
    assert.equal(code.address, ADDR, `${btn.capture} address`);
    assert.equal(code.command, btn.command, `${btn.capture} command`);
    assert.equal(code.data, displayFor(btn.command) >>> 0, `${btn.capture} display-form data`);
    assert.equal(bitReverseBytes(code.data as number, code.bits), btn.accumulated, `${btn.capture} datalsb matches the keycode word`);
  }
});