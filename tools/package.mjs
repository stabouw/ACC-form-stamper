/**
 * Maakt een zip van `src/` om aan collega's te geven.
 *
 * Draaien met: node tools/package.mjs
 * Resultaat:   dist/acc-form-stamper-<versie>.zip
 *
 * Het inpakken zelf is triviaal. De controle eromheen is dat niet, en is de
 * eigenlijke reden dat dit script bestaat.
 *
 * De extensie meldt aan bij Autodesk via een callback-URL die vastligt op het
 * extensie-id:
 *
 *     https://<extensie-id>.chromiumapp.org/
 *
 * Dat id is geen willekeurig nummer maar een afgeleide van het `key`-veld in de
 * manifest. Verdwijnt die key, of wordt hij vervangen, dan krijgt de extensie een
 * ander id, klopt de callback-URL niet meer met wat er bij Autodesk geregistreerd
 * staat, en mislukt het aanmelden met een melding waar niemand iets aan heeft
 * ("invalid redirect_uri").
 *
 * Dat is precies het soort fout dat je pas ontdekt bij de collega die hem
 * uitpakt. Dus rekent dit script het id uit de key uit en legt het naast de URL
 * in `config.js` — en pakt niets in als die twee niet overeenkomen.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORTEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRON = join(WORTEL, 'src');
const DIST = join(WORTEL, 'dist');

/**
 * Rekent het extensie-id uit de publieke sleutel uit.
 *
 * Chromium neemt de SHA-256 van de DER-bytes van de sleutel, houdt de eerste 16
 * bytes over, en vertaalt elk hexcijfer (0-f) naar een letter (a-p). Vandaar dat
 * een extensie-id altijd 32 letters uit de eerste helft van het alfabet is.
 */
function extensieId(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((teken) => String.fromCharCode(97 + parseInt(teken, 16))).join('');
}

const manifest = JSON.parse(readFileSync(join(BRON, 'manifest.json'), 'utf8'));

if (!manifest.key) {
  console.error(
    'STOP: er staat geen "key" in src/manifest.json.\n\n' +
      'Zonder die key krijgt de extensie op elke machine een ander id, en dan\n' +
      'mislukt het aanmelden bij Autodesk. Zet hem terug voordat je uitdeelt.',
  );
  process.exit(1);
}

const id = extensieId(manifest.key);
const callback = `https://${id}.chromiumapp.org/`;

// Niet de constante importeren maar de tekst lezen: config.js trekt bij het
// importeren `chrome.identity` open, en dat bestaat hier niet.
const config = readFileSync(join(BRON, 'config.js'), 'utf8');
const verwacht = /EXPECTED_REDIRECT_URI\s*=\s*'([^']+)'/.exec(config)?.[1];

if (callback !== verwacht) {
  console.error(
    'STOP: de key en de callback-URL lopen uiteen.\n\n' +
      `  key levert id:   ${id}\n` +
      `  dus callback:    ${callback}\n` +
      `  in config.js:    ${verwacht}\n\n` +
      'Eén van beide klopt niet. Is de key bewust vervangen, pas dan config.js\n' +
      'aan én registreer de nieuwe callback-URL bij de APS-app. Anders mislukt\n' +
      'het aanmelden voor iedereen die dit pakket uitpakt.',
  );
  process.exit(1);
}

/**
 * Waar de extensie op de machine van de gebruiker komt te staan.
 *
 * Een vaste plek, en met opzet niet Downloads: Edge laadt een uitgepakte
 * extensie elke keer opnieuw vanaf zijn map, dus zodra iemand zijn downloads
 * opruimt is de extensie weg.
 */
const INSTALLATIENAAM = manifest.name.replace(/\s+/g, '-');
const DOELMAP = `C:\\_Data\\Heijmans\\${INSTALLATIENAAM}`;

// Uitpakken levert één map op met het installatiescript en de extensie ernaast.
// De gebruiker draait het script; de map `extensie` hoeft hij nooit aan te raken.
const naam = `acc-form-stamper-${manifest.version}`;
const staging = join(DIST, naam);
const zip = join(DIST, `${naam}.zip`);

rmSync(staging, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync(staging, { recursive: true });

cpSync(BRON, join(staging, 'extensie'), { recursive: true });

// De tests horen niet in een pakket dat je uitdeelt.
for (const bestand of ['stamp.test.js', 'journaal.test.js']) {
  const pad = join(staging, 'extensie', bestand);
  if (existsSync(pad)) rmSync(pad);
}

// Het installatiescript uit zijn sjabloon, zodat de doelmap op één plek vastligt
// en niet uit de pas kan lopen met wat hier berekend wordt.
const script = readFileSync(join(WORTEL, 'tools', 'installeren.cmd.template'), 'utf8')
  .replaceAll('__DOELMAP__', DOELMAP)
  .replaceAll('__VERSIE__', manifest.version);

// CRLF, want dit is een .cmd: cmd.exe struikelt over losse regeleindes in
// meerregelige constructies.
writeFileSync(join(staging, 'installeren.cmd'), script.replace(/\r?\n/g, '\r\n'), 'utf8');

writeFileSync(
  join(staging, 'LEES DIT EERST.txt'),
  [
    `Form Stamper ${manifest.version}`,
    '',
    'Dubbelklik op  installeren.cmd  en volg de aanwijzingen.',
    '',
    `De extensie wordt geplaatst in ${DOELMAP} en je krijgt daarna te zien`,
    'hoe je hem eenmalig in Edge laadt.',
    '',
    'De map "extensie" hoef je niet zelf te openen.',
    '',
    'Uitgebreidere uitleg staat in INSTALLEREN.md.',
    '',
  ].join('\r\n'),
  'utf8',
);

// Node kan zelf geen zip schrijven; Compress-Archive zit standaard op Windows.
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path '${staging}' -DestinationPath '${zip}' -Force`,
  ],
  { stdio: 'inherit' },
);

rmSync(staging, { recursive: true, force: true });

console.log(`
Klaar: dist/${naam}.zip

  extensie-id  ${id}
  callback     ${callback}
  versie       ${manifest.version}
  installeert  ${DOELMAP}

Geef het zipbestand mee met docs/INSTALLEREN.md.
`);
