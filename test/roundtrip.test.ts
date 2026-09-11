import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Converter } from '../src/lib/converter.js';

const converter = new Converter();

const specs = [
  { proto: 'NEC', args: '0x10EF00FF' },
  { proto: 'NEC', args: { address: 4, subaddress: 0, command: 8 } },
  { proto: 'JVC', args: '0x030C' },
  { proto: 'JVC', args: { address: 3, command: 12 } },
  { proto: 'SAMSUNG', args: '0xE0E040BF' },
  { proto: 'SAMSUNG', args: { address: 0xe0, command: 0x40 } },
  { proto: 'SAMSUNG', args: { address: 4, command: 0xff } },
];

test('protocol -> Pronto -> timing decode roundtrip preserves the code', () => {
  for (const spec of specs) {
    const orig = converter.importCode(spec.proto, spec.args as never);
    const pronto = converter.exportCode(orig, 'Pronto');
    const decoded = converter.importFormat('Pronto', pronto)[0];

    assert.equal(decoded.protocol, orig.protocol, `${spec.proto} protocol survives roundtrip`);
    assert.equal(decoded.address, orig.address, `${spec.proto} address survives roundtrip`);
    assert.equal(decoded.command, orig.command, `${spec.proto} command survives roundtrip`);
    assert.equal(decoded.data, orig.data, `${spec.proto} data survives roundtrip`);
  }
});
