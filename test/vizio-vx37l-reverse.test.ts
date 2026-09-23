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
import { Converter } from '../src/lib/converter.js';
import type { IRCode } from '../src/lib/code.js';

const converter = new Converter();

const vizioVx37lLirc = String.raw`# this config file was automatically generated
# using lirc-0.8.3pre1(default) on Mon Nov 26 23:16:08 2007
#
# contributed by Chris Moates <six|mox.ne>
#
# brand:                                   Vizio
# model no. of remote control:             Unknown. Black remote with no backlighting.
# devices being controlled by this remote: Vizio VX37L LCD TV
#
# I recorded this with irrecord, but then reversed the flags because they
# make a lot more sense that way. I did try the other combinations according
# to the pattern that is evident, but found no other codes aside from the
# ones on the remote, so no discreets to switch to a particular HDMI input,
# for example. :(

begin remote

  name  Vizio_VX37L
  bits           16
  flags SPACE_ENC|CONST_LENGTH|REVERSE
  eps            30
  aeps          100

  header       8939  4447
  one           547  1684
  zero          547   565
  ptrail        539
  pre_data_bits   16
  pre_data       0xFB04
  gap          107074
  toggle_bit_mask 0x0

      begin codes
          KEY_TV                   0x29D6                    #  Was: tv
          hdmi                     0x39C6
          rgb                      0x6798
          wide                     0x8877
          KEY_MODE                 0x9867                    #  Was: mode
          swap                     0x9966
          freeze                   0x9A65
          pipch+                   0x9B64
          pipch-                   0x9C63
          pipinput                 0x9D62
          pipsize                  0x9E61
          pip                      0x9F60
          component                0xA55A
          av                       0xAE51
          KEY_EXIT                 0xB649                    #  Was: exit
          KEY_RIGHT                0xB748                    #  Was: right
          KEY_LEFT                 0xB847                    #  Was: left
          KEY_DOWN                 0xB946                    #  Was: down
          KEY_UP                   0xBA45                    #  Was: up
          KEY_OK                   0xBB44                    #  Was: ok
          KEY_MENU                 0xBC43                    #  Was: menu
          KEY_ZOOMOUT              0xBE41                    #  Was: zoom-
          KEY_ZOOMIN               0xBF40                    #  Was: zoom+
          cc                       0xC639
          KEY_INFO                 0xE41B                    #  Was: info
          KEY_ENTER                0x00FF                    #  Was: enter
          input                    0xD02F
          KEY_INFO                 0xE31C                    #  Was: guide
          KEY_LAST                 0xE51A                    #  Was: last
          KEY_9                    0xE619                    #  Was: 9
          KEY_8                    0xE718                    #  Was: 8
          KEY_7                    0xE817                    #  Was: 7
          KEY_6                    0xE916                    #  Was: 6
          KEY_5                    0xEA15                    #  Was: 5
          KEY_4                    0xEB14                    #  Was: 4
          KEY_3                    0xEC13                    #  Was: 3
          KEY_2                    0xED12                    #  Was: 2
          KEY_1                    0xEE11                    #  Was: 1
          KEY_0                    0xEF10                    #  Was: 0
          KEY_SLEEP                0xF10E                    #  Was: sleep
          KEY_AUDIO                0xF40B                    #  Was: audio
          mts                      0xF50A
          KEY_MUTE                 0xF609                    #  Was: mute
          KEY_POWER                0xF708                    #  Was: power
          KEY_VOLUMEDOWN           0xFC03                    #  Was: voldn
          KEY_VOLUMEUP             0xFD02                    #  Was: volup
          chdn                     0xFE01
          KEY_CHANNELUP            0xFF00                    #  Was: chup
      end codes

end remote
`;

const vizioVx37lIrdbCsv = String.raw`functionname,protocol,device,subdevice,function
KEY_CHANNELUP,NEC,4,-1,0
chdn,NEC,4,-1,1
KEY_VOLUMEUP,NEC,4,-1,2
KEY_VOLUMEDOWN,NEC,4,-1,3
KEY_POWER,NEC,4,-1,8
KEY_MUTE,NEC,4,-1,9
mts,NEC,4,-1,10
KEY_AUDIO,NEC,4,-1,11
KEY_SLEEP,NEC,4,-1,14
KEY_0,NEC,4,-1,16
KEY_1,NEC,4,-1,17
KEY_2,NEC,4,-1,18
KEY_3,NEC,4,-1,19
KEY_4,NEC,4,-1,20
KEY_5,NEC,4,-1,21
KEY_6,NEC,4,-1,22
KEY_7,NEC,4,-1,23
KEY_8,NEC,4,-1,24
KEY_9,NEC,4,-1,25
KEY_LAST,NEC,4,-1,26
KEY_INFO,NEC,4,-1,27
KEY_INFO,NEC,4,-1,28
input,NEC,4,-1,47
cc,NEC,4,-1,57
KEY_ZOOMIN,NEC,4,-1,64
KEY_ZOOMOUT,NEC,4,-1,65
KEY_MENU,NEC,4,-1,67
KEY_OK,NEC,4,-1,68
KEY_UP,NEC,4,-1,69
KEY_DOWN,NEC,4,-1,70
KEY_LEFT,NEC,4,-1,71
KEY_RIGHT,NEC,4,-1,72
KEY_EXIT,NEC,4,-1,73
av,NEC,4,-1,81
component,NEC,4,-1,90
pip,NEC,4,-1,96
pipsize,NEC,4,-1,97
pipinput,NEC,4,-1,98
pipch-,NEC,4,-1,99
pipch+,NEC,4,-1,100
freeze,NEC,4,-1,101
swap,NEC,4,-1,102
KEY_MODE,NEC,4,-1,103
wide,NEC,4,-1,119
rgb,NEC,4,-1,152
hdmi,NEC,4,-1,198
KEY_TV,NEC,4,-1,214
KEY_ENTER,NEC,4,-1,255
`;

const vizioLcdTvLirc = String.raw`#
# this config file was automatically generated
# using lirc-0.8.5-CVS(default) on Thu Apr  9 18:12:26 2009
#
# contributed by
#
# brand:                       Vizio remote
# model no. of remote control: 0980-0305-3000
# devices being controlled by this remote:
#

begin remote

  name  Vizio
  bits           16
  flags SPACE_ENC
  eps            30
  aeps          100

  header       8966  4400
  one           567  1596
  zero          567   494
  ptrail        575
  repeat       9000  2194
  pre_data_bits   16
  pre_data       0x20DF
  gap          40403
  repeat_gap   95450
  toggle_bit_mask 0x0

      begin codes
          KEY_INFO                 0x38C7                    #  Was: Guide
          AV                       0x8A75
          COMP                     0x5AA5
          HDMI                     0x639C
          KEY_UP                   0xA25D                    #  Was: UP
          KEY_TV                   0x6B94                    #  Was: TV
          KEY_LEFT                 0xE21D                    #  Was: LEFT
          KEY_DOWN                 0x629D                    #  Was: DOWN
          KEY_RIGHT                0x12ED                    #  Was: RIGHT
          KEY_MENU                 0xC23D                    #  Was: MENU
          KEY_MUTE                 0x906F                    #  Was: MUTE
          KEY_LAST                 0x58A7                    #  Was: LAST
          KEY_VOLUMEUP             0x40BF                    #  Was: VOL_UP
          VOL_DWN                  0xC03F
          KEY_CHANNELUP            0x00FF                    #  Was: CH_UP
          CH_DWN                   0x807F
          KEY_1                    0x8877                    #  Was: ONE
          KEY_2                    0x48B7                    #  Was: TWO
          KEY_3                    0xC837                    #  Was: THREE
          KEY_4                    0x28D7                    #  Was: FOUR
          KEY_5                    0xA857                    #  Was: FIVE
          KEY_6                    0x6897                    #  Was: SIX
          KEY_7                    0xE817                    #  Was: SEVEN
          KEY_8                    0x18E7                    #  Was: EIGHT
          KEY_9                    0x9867                    #  Was: NINE
          KEY_0                    0x08F7                    #  Was: ZERO
          INPUT                    0xF40B
          DASH                     0xFF00
          KEY_POWER                0x10EF                    #  Was: POWER
      end codes

end remote


`;


const loadLirc = (text: string) => converter.importFormat('LIRC', text);
const loadIrdb = (text: string) => converter.importFormat('CSV', text);

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
  const power = loadLirc(vizioVx37lLirc).find((c) => c.alias === 'KEY_POWER');
  assert.ok(power, 'KEY_POWER imported from LIRC');
  assert.deepEqual(
    { protocol: power.protocol, bits: power.bits, address: power.address, subaddress: power.subaddress, command: power.command, data: power.data },
    EXPECTED(8),
    'REVERSE words are mirrored and reduced to the display form',
  );
});

test('LIRC VX37L decodes the same NEC address 4 / command 8 signal as IRDB', () => {
  const lirc = loadLirc(vizioVx37lLirc);
  const irdb = loadIrdb(vizioVx37lIrdbCsv);

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
  const lirc = loadLirc(vizioVx37lLirc);
  const irdb = loadIrdb(vizioVx37lIrdbCsv);
  const pronto = (code: IRCode) => converter.exportCode(code, 'Pronto').trim();

  for (const [alias] of BUTTONS) {
    const l = lirc.find((c) => c.alias === alias)!;
    const i = irdb.find((c) => c.alias === alias)!;
    assert.equal(pronto(l), pronto(i), `Pronto for ${alias} is identical`);
  }
});

test('LIRC VX37L REVERSE and LCD_TV (non-REVERSE) describe the same NEC power signal', () => {
  const reverse = loadLirc(vizioVx37lLirc).find((c) => c.alias === 'KEY_POWER')!;
  const plain = loadLirc(vizioLcdTvLirc).find((c) => c.alias === 'KEY_POWER')!;
  assert.equal(reverse.data, plain.data, 'both land on the same display form');
  assert.equal(reverse.address, plain.address, 'same address');
  assert.equal(reverse.command, plain.command, 'same command');
});