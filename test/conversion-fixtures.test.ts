import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { Converter } from '../src/lib/converter.js';

// Data-driven conversion tests backed by the per-protocol fixture files in
// test/fixtures/conv-*.tsv (copied from the Perl IR::Code distribution).
// Each file is hand-editable reference data. Column layout:
//
//   name, protocol, address, subaddress, command, expected Pronto hex,
//   decoded protocol, decoded address, decoded subaddress, decoded command
//
// For every row both conversion directions are checked against the file:
//   structured (protocol/address/subaddress/command) -> Pronto hex must equal
//   the file, and Pronto hex -> structured must equal the decoded columns.
// The decoded columns differ from the source columns for frame variants
// that share a timing signature: NEC2 decodes as NEC, the half-header
// NECX1/NECX2 decode as SAMSUNG with bit-reversed address/command bytes, and
// 48-NEC2 decodes as 48-NEC1. Protocols without a subaddress field record -1.

const converter = new Converter();
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'fixtures');

const files = readdirSync(dataDir).filter((f) => f.startsWith('conv-') && f.endsWith('.tsv'));

test('per-protocol conversion fixtures present', () => {
  assert.ok(files.length >= 11, 'expected at least 11 conv-*.tsv fixtures');
});

function int(v: string): number {
  return /^0x/i.test(v) ? Number.parseInt(v, 16) : Number(v);
}

for (const file of files) {
  const proto = basename(file, '.tsv').replace(/^conv-/, '');

  test(`conversion fixture: ${proto}`, () => {
    const lines = readFileSync(join(dataDir, file), 'utf8').split(/\r?\n/);
    let rows = 0;
    for (const line of lines) {
      if (line.trim() === '' || /^\s*#/.test(line)) continue;
      rows++;
      const cols = line.split('\t');
      assert.equal(cols.length, 10, `row ${rows} has 10 columns`);

      const name = cols[0];
      const srcProto = cols[1];
      const addr = int(cols[2]);
      const sub = int(cols[3]);
      const cmd = int(cols[4]);
      const expectedPronto = cols[5];
      const decProto = cols[6];
      const decAddr = int(cols[7]);
      const decSub = int(cols[8]);
      const decCmd = int(cols[9]);

      // Structured -> Pronto.
      const code = converter.importCode(srcProto, { address: addr, subaddress: sub, command: cmd });
      assert.equal(
        converter.exportCode(code, 'Pronto'),
        expectedPronto,
        `${name}: structured ${srcProto} ${addr}/${sub}/${cmd} encodes to the fixture Pronto hex`,
      );

      // Pronto -> structured (timing decode).
      const back = converter.importFormat('Pronto', expectedPronto)[0];
      assert.equal(back.protocol, decProto, `${name}: Pronto decodes as ${decProto}`);
      assert.equal(back.address, decAddr, `${name}: decoded address ${decAddr}`);
      assert.equal(back.subaddress, decSub, `${name}: decoded subaddress ${decSub}`);
      assert.equal(back.command, decCmd, `${name}: decoded command ${decCmd}`);
    }
  });
}
