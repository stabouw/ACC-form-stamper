/**
 * Tekent het extensie-icoon: het blauwe rondje met het witte stempel, hetzelfde
 * merkteken dat in de gele balk van de popup staat.
 *
 * Draaien met: node tools/make-icons.mjs
 *
 * Waarom een eigen tekenprogramma en geen PNG'tje in de repo: Chrome accepteert
 * geen SVG als extensie-icoon, dus er moeten bitmaps zijn — maar een bitmap die
 * niemand kan terugrekenen naar zijn bron is over een jaar niet meer te wijzigen.
 * Dit bestand is die bron. Er zitten geen afhankelijkheden onder; `zlib` uit Node
 * is genoeg voor een PNG.
 *
 * Het pad komt letterlijk uit het ontwerp (`docs/design_handoff_form_stamper/`):
 * een 24×24 viewBox met een afgerond rechthoekje, een trapezium eronder en een
 * grondlijn, in witte lijnen van 2 breed met ronde uiteinden.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');

/** Heijmans-blauw, hetzelfde als `--hjm-blue` in de popup. */
const BLAUW = [0, 0x33, 0x66];
const WIT = [255, 255, 255];

/** Zoveel monsters per pixel per as; 4×4 is ruim genoeg voor randen die glad ogen. */
const SUPERSAMPLE = 4;

// -----------------------------------------------------------------------------
// Afstandsfuncties, in de coördinaten van de 24×24 viewBox
// -----------------------------------------------------------------------------

/** Afstand tot een lijnstuk. Ronde uiteinden volgen hier vanzelf uit. */
function afstandTotSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const lengte = vx * vx + vy * vy;
  const t = lengte === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lengte));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Afstand tot de rand van een afgeronde rechthoek; negatief binnenin. */
function afstandTotAfgerondeRechthoek(px, py, cx, cy, halfB, halfH, straal) {
  const dx = Math.abs(px - cx) - (halfB - straal);
  const dy = Math.abs(py - cy) - (halfH - straal);
  const buiten = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return buiten + Math.min(Math.max(dx, dy), 0) - straal;
}

/**
 * Hoeveel van het stempelteken ligt er op dit punt? 0 = niets, 1 = vol wit.
 *
 * Alle onderdelen zijn lijnen van 2 breed, dus overal geldt: binnen 1 van de
 * vorm is het teken.
 */
function stempelDekking(x, y) {
  const halveLijn = 1;

  // Het kussen bovenaan: rect(8,3,8×7) met hoekstraal 1.5, alleen de omtrek.
  const kussen = Math.abs(afstandTotAfgerondeRechthoek(x, y, 12, 6.5, 4, 3.5, 1.5)) - halveLijn;

  // De steel eronder: M8 10 l-2 6 h12 l-2 -6.
  const steel =
    Math.min(
      afstandTotSegment(x, y, 8, 10, 6, 16),
      afstandTotSegment(x, y, 6, 16, 18, 16),
      afstandTotSegment(x, y, 18, 16, 16, 10),
    ) - halveLijn;

  // De grondlijn: M4 20 h16.
  const grond = afstandTotSegment(x, y, 4, 20, 20, 20) - halveLijn;

  return Math.min(kussen, steel, grond) <= 0 ? 1 : 0;
}

// -----------------------------------------------------------------------------
// PNG schrijven
// -----------------------------------------------------------------------------

const crcTabel = (() => {
  const tabel = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabel[n] = c >>> 0;
  }
  return tabel;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTabel[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const lengte = Buffer.alloc(4);
  lengte.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([lengte, body, crc]);
}

function schrijfPng(pad, breedte, hoogte, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(breedte, 0);
  ihdr.writeUInt32BE(hoogte, 4);
  ihdr[8] = 8; // bits per kanaal
  ihdr[9] = 6; // kleurtype 6 = RGBA
  // 10..12 blijven 0: standaard compressie, standaard filter, niet interlaced.

  // Elke regel krijgt een filterbyte 0 ervoor: geen filter, gewoon de bytes.
  const rauw = Buffer.alloc(hoogte * (1 + breedte * 4));
  for (let y = 0; y < hoogte; y++) {
    const van = y * breedte * 4;
    rauw[y * (1 + breedte * 4)] = 0;
    rgba.copy(rauw, y * (1 + breedte * 4) + 1, van, van + breedte * 4);
  }

  writeFileSync(
    pad,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(rauw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

// -----------------------------------------------------------------------------
// Het icoon
// -----------------------------------------------------------------------------

function tekenIcoon(maat) {
  const rgba = Buffer.alloc(maat * maat * 4);
  const midden = maat / 2;
  const straal = maat / 2;

  // Het teken beslaat 12 van de 21 punten van het rondje, net als `.icon-badge`
  // in de popup: een svg van 12 in een cirkel van 21.
  const schaal = (maat * (12 / 21)) / 24;

  for (let y = 0; y < maat; y++) {
    for (let x = 0; x < maat; x++) {
      let cirkel = 0;
      let teken = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) / SUPERSAMPLE;
          const py = y + (sy + 0.5) / SUPERSAMPLE;

          if (Math.hypot(px - midden, py - midden) > straal) continue;
          cirkel += 1;

          // Van pixels terug naar de 24×24 viewBox waarin het pad beschreven is.
          teken += stempelDekking((px - midden) / schaal + 12, (py - midden) / schaal + 12);
        }
      }

      const monsters = SUPERSAMPLE * SUPERSAMPLE;
      const alfa = cirkel / monsters;
      if (alfa === 0) continue;

      // Wit over blauw mengen op basis van hoeveel van de pixel het teken raakt.
      const witAandeel = teken / monsters / (alfa || 1);
      const i = (y * maat + x) * 4;
      for (let k = 0; k < 3; k++) {
        rgba[i + k] = Math.round(BLAUW[k] * (1 - witAandeel) + WIT[k] * witAandeel);
      }
      rgba[i + 3] = Math.round(alfa * 255);
    }
  }

  return rgba;
}

mkdirSync(UIT, { recursive: true });

for (const maat of [16, 32, 48, 128]) {
  const pad = join(UIT, `icon-${maat}.png`);
  schrijfPng(pad, maat, maat, tekenIcoon(maat));
  console.log(`geschreven: ${pad}`);
}
