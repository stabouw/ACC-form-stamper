/**
 * De popup. Stap 1 en 2 zijn aangesloten; 3 en 4 nog niet.
 *
 * Er zit hier met opzet geen APS-logica. De popup vraagt de service worker wat
 * er gaat gebeuren en tekent het antwoord — het samenstellen van het stempel
 * hoort in de worker, niet hier.
 *
 * Eén ding doet de popup wél zelf: het tempo. De selectie gaat in blokken van
 * twintig naar `previewForms`, en na elk blok wordt er getekend. Zo vult de
 * tabel zich terwijl de rest nog loopt, en is er geen apart wachtscherm nodig
 * (docs/design-decisions.md, punt 2).
 */

/** De grens van `relationships:intersect`. Groter mag niet, kleiner is zonde. */
const BLOKGROOTTE = 20;

// Forma Build toont 50 formulieren per pagina, maar de selectie loopt daar
// dwars doorheen: aanvinken op meerdere pagina's stapelt gewoon op. Er is dus
// geen grens om rekening mee te houden.

const el = (id) => document.getElementById(id);

const schermen = {
  login: { node: el('screen-login'), label: 'Stap 1 van 4 - Inloggen' },
  select: { node: el('screen-select'), label: 'Stap 2 van 4 - Selecteren' },
  stamp: { node: el('screen-stamp'), label: 'Stap 3 van 4 - Stempelen' },
  summary: { node: el('screen-summary'), label: 'Stap 4 van 4 - Samenvatting' },
};

const staat = {
  formulieren: [],
  projectId: null,
  projectNaam: null,
  geslotenAan: false,
  /** De lopende uitvoering: rijen in verwerkingsvolgorde, plus de stand van zaken. */
  run: null,
};

function toon(naam) {
  for (const [key, scherm] of Object.entries(schermen)) {
    scherm.node.hidden = key !== naam;
  }
  el('step-label').textContent = schermen[naam].label;
}

// -----------------------------------------------------------------------------
// Praten met de service worker en met de pagina
// -----------------------------------------------------------------------------

/**
 * Stuurt een bericht naar de service worker.
 *
 * De worker antwoordt met `{ok, result}` of `{ok:false, error}`. Die tweede vorm
 * wordt hier een echte `Error`, zodat de aanroepende code gewoon `try/catch`
 * kan gebruiken en de `needsSignIn`-vlag niet onderweg verdwijnt.
 */
function vraag(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        const fout = new Error(response?.error?.message ?? 'Er ging iets mis.');
        Object.assign(fout, response?.error ?? {});
        reject(fout);
        return;
      }
      resolve(response.result);
    });
  });
}

/**
 * Vraagt de actieve tab om zijn selectie.
 *
 * Zit het content script er niet — omdat dit geen Forma Build-pagina is —, dan
 * levert `sendMessage` een `lastError` op. Dat is hier geen storing maar het
 * normale geval van "je staat op de verkeerde pagina", en het verdient dus die
 * uitleg en niet de foutmelding van de browser.
 */
const GEEN_PAGINA =
  'Open het formulieroverzicht van Forma Build en vink daar de formulieren aan ' +
  'die je wilt stempelen.';

/** Eén poging. Levert `null` als het content script niet antwoordt. */
function stuurNaarTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'getSelection' }, (response) => {
      // `lastError` uitlezen is verplicht, anders logt Chrome hem als
      // onafgehandelde fout in de console van de popup.
      if (chrome.runtime.lastError || !response) resolve(null);
      else resolve(response);
    });
  });
}

/**
 * Zet de content scripts alsnog in de pagina.
 *
 * Nodig omdat scripts uit de manifest alleen bij het laden van een pagina worden
 * geïnjecteerd. Installeer of herlaad je de extensie terwijl een ACC-tabblad al
 * open staat, dan heeft dat tabblad ze niet — en dan lijkt het alsof er niets is
 * aangevinkt, terwijl de lijst vol vinkjes staat.
 *
 * Dat was precies het geval na een verse installatie: pas na het verversen van
 * de pagina werkte het. De gebruiker daarom om een refresh vragen kan, maar het
 * alsnog injecteren is hetzelfde werk en scheelt hem de vraag.
 */
async function injecteerContentScripts(tabId) {
  try {
    // Volgorde telt: de brug in de isolated world stelt zijn vragen aan het
    // MAIN-script, dus dat moet er eerst zijn.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/selection-main.js'],
      world: 'MAIN',
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/selection.js'],
    });
    return true;
  } catch {
    // Geen rechten op dit tabblad: dan is het geen ACC-pagina.
    return false;
  }
}

async function vraagSelectie() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: 'Geen actief tabblad gevonden.' };

  const eerste = await stuurNaarTab(tab.id);
  if (eerste) return eerste;

  if (!(await injecteerContentScripts(tab.id))) return { ok: false, error: GEEN_PAGINA };

  return (await stuurNaarTab(tab.id)) ?? { ok: false, error: GEEN_PAGINA };
}

// -----------------------------------------------------------------------------
// Stap 2 tekenen
// -----------------------------------------------------------------------------

const TAGS = {
  nieuw: { klasse: 'new', tekst: 'nieuw' },
  bijgewerkt: { klasse: 'upd', tekst: 'bijgewerkt' },
  ongewijzigd: { klasse: 'skip', tekst: 'ongewijzigd' },
  'past-niet': { klasse: 'stop', tekst: 'past niet' },
};

const WAARSCHUWING_ICOON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 3l9 16H3z"/><path d="M12 10v4"/><path d="M12 17.5v.01"/></svg>';

/**
 * Wordt dit formulier bij deze instellingen daadwerkelijk geschreven?
 *
 * Drie redenen om over te slaan: er verandert niets, het past niet binnen de
 * 8000 tekens, of het is gesloten terwijl de schakelaar uit staat.
 */
function wordtGestempeld(f) {
  if (f.tag === 'ongewijzigd' || f.tag === 'past-niet') return false;
  if (f.gesloten && !staat.geslotenAan) return false;
  return true;
}

/**
 * De assetkolom.
 *
 * Kort hier op een eigen manier in, en nadrukkelijk niet met `(+N meer)`: dat is
 * de afkapmarkering van de 8000-tekenladder, en die in de tabel hergebruiken
 * zou een lange lijst laten lijken op een afgekapt stempel.
 */
function assetCel(f) {
  if (f.assets.length === 0) {
    // Alleen een waarschuwing als er ook werkelijk iets verandert: de assetregel
    // stond er en wordt nu leeggemaakt. Een formulier dat nooit assets had en er
    // nog steeds geen heeft, gebeurt niets mee — daar is "ongewijzigd" in de
    // statuskolom genoeg. Anders staat de halve tabel vol gele vlakken en valt
    // de ene rij waar het wél om gaat niet meer op.
    if (!f.assetregelVervalt) {
      return '<span class="geen-assets">Geen gekoppelde assets</span>';
    }
    return (
      `<div class="note-empty">${WAARSCHUWING_ICOON}` +
      '<span>Assetregel wordt leeggemaakt — er zijn geen gekoppelde assets meer</span></div>'
    );
  }

  const eerste = f.assets.slice(0, 3).map(escapeHtml).join(', ');
  const rest = f.assets.length - 3;

  // De volledige lijst in de tooltip: de kolom is te smal om er twintig te tonen,
  // maar "en 17 andere" laat de gebruiker gissen naar wat er precies gestempeld
  // wordt. `escapeHtml` dekt ook de aanhalingstekens, dus dit is veilig in een
  // attribuut.
  let html =
    rest > 0
      ? `${eerste} <span class="meer" title="${escapeHtml(f.assets.join(', '))}">en ${rest} andere</span>`
      : eerste;

  if (f.tag === 'past-niet') {
    html +=
      `<div class="limit-note blocked">${WAARSCHUWING_ICOON}` +
      '<span>Past niet binnen 8000 tekens — er wordt niets geschreven</span></div>';
  } else if (f.ingekort) {
    html +=
      `<div class="limit-note shortened">${WAARSCHUWING_ICOON}` +
      `<span>Ingekort naar de 8000-teken limiet — ${f.getoond} van ${f.totaal} assets</span></div>`;
  }

  return html;
}

function escapeHtml(waarde) {
  return String(waarde).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function rijHtml(f) {
  const tag = TAGS[f.tag] ?? TAGS.ongewijzigd;
  const naam = `#${f.formNum} - ${escapeHtml(f.naam)}`;
  const pill = f.gesloten ? '<div class="pill-closed">gesloten</div>' : '';

  return (
    '<tr>' +
    `<td>${naam}${pill}</td>` +
    `<td>${assetCel(f)}</td>` +
    `<td><span class="status ${tag.klasse}">${tag.tekst}</span></td>` +
    '</tr>'
  );
}

/**
 * Tekent alles wat van de huidige staat afhangt. Eén plek, zodat niets scheef
 * kan lopen.
 *
 * `lezen` is de toestand vóór het eerste antwoord van de pagina. Die moet apart,
 * want "nog niet gevraagd" en "nul geselecteerd" zien er anders identiek uit —
 * en dat tweede is rood. Een rode nul laten zien terwijl je het antwoord nog
 * niet hebt, is een foutmelding over iets dat niet is misgegaan.
 */
function tekenSelectie({ bezig = false, gedaan = 0, totaal = 0, lezen = false } = {}) {
  const rijen = el('select-rows');
  rijen.innerHTML = staat.formulieren.map(rijHtml).join('');

  el('select-loading').hidden = !bezig;
  if (bezig) {
    el('select-progress').textContent =
      `${gedaan} van ${totaal} formulieren opgehaald — er is nog niets gewijzigd`;
  }

  // De schakelaar bestaat alleen als er gesloten formulieren zijn waar hij ook
  // iets aan verandert (punt 3). Een gesloten formulier dat toch al "ongewijzigd"
  // is, wordt met de schakelaar aan net zo goed overgeslagen — dan zou de vraag
  // alleen maar de onomkeerbare kant in beeld brengen zonder dat er iets tegenover
  // staat.
  const gesloten = staat.formulieren.filter(
    (f) => f.gesloten && f.tag !== 'ongewijzigd' && f.tag !== 'past-niet',
  );
  el('closed-box').hidden = gesloten.length === 0;
  el('closed-count').textContent =
    `${gesloten.length} gesloten ${gesloten.length === 1 ? 'formulier' : 'formulieren'} in deze selectie`;
  el('closed-toggle').setAttribute('aria-checked', String(staat.geslotenAan));

  const telling = el('select-count');
  const aantal = staat.formulieren.length + (bezig ? totaal - gedaan : 0);
  telling.textContent = lezen
    ? 'Selectie wordt gelezen…'
    : `${aantal} ${aantal === 1 ? 'formulier' : 'formulieren'} geselecteerd`;
  telling.classList.toggle('empty', !lezen && !bezig && aantal === 0);

  const teStempelen = staat.formulieren.filter(wordtGestempeld).length;
  el('btn-stamp').disabled = lezen || bezig || teStempelen === 0;
}

/**
 * Haalt de selectie op en verrijkt hem blok voor blok.
 *
 * Elk blok wordt getekend zodra het binnen is. Bij honderd formulieren staan de
 * eerste twintig rijen er dus al terwijl de rest nog onderweg is.
 */
async function laadSelectie() {
  staat.formulieren = [];
  el('select-error').hidden = true;
  tekenSelectie({ lezen: true });

  const selectie = await vraagSelectie();
  if (!selectie.ok) {
    el('select-error').textContent = selectie.error;
    el('select-error').hidden = false;
    el('select-count').textContent = '0 formulieren geselecteerd';
    el('select-count').classList.add('empty');
    el('btn-stamp').disabled = true;
    return;
  }

  staat.projectId = selectie.projectId;

  const { naam } = await vraag('getProjectNaam', { projectId: selectie.projectId });
  staat.projectNaam = naam;
  const naamveld = el('project-name');
  naamveld.textContent = naam ?? '';
  // Lange projectnamen worden afgekapt met een beletselteken; de tooltip houdt
  // de volledige naam bereikbaar.
  naamveld.title = naam ?? '';
  naamveld.hidden = !naam;

  const ids = selectie.formIds ?? [];
  if (ids.length === 0) {
    tekenSelectie();
    return;
  }

  let ontbrekend = 0;

  for (let i = 0; i < ids.length; i += BLOKGROOTTE) {
    const blok = ids.slice(i, i + BLOKGROOTTE);
    try {
      const resultaat = await vraag('previewForms', {
        projectId: selectie.projectId,
        formIds: blok,
      });
      staat.formulieren.push(...resultaat.formulieren);
      ontbrekend += resultaat.ontbrekend?.length ?? 0;
    } catch (fout) {
      // Een verlopen aanmelding is iets anders dan een kapot blok: dan hoort de
      // gebruiker terug naar Inloggen, niet naar een halve tabel.
      if (fout.needsSignIn) {
        naarLogin('Je aanmelding is verlopen. Meld je opnieuw aan.');
        return;
      }
      el('select-error').textContent = fout.message;
      el('select-error').hidden = false;
      break;
    }
    tekenSelectie({ bezig: i + BLOKGROOTTE < ids.length, gedaan: staat.formulieren.length, totaal: ids.length });
  }

  tekenSelectie();

  // Een aangevinkt formulier dat het project niet kent, hoort niet stil te
  // verdwijnen: dan telt de tabel anders dan de lijst in ACC, en dat is precies
  // het soort verschil waardoor niemand de tool nog vertrouwt.
  if (ontbrekend > 0) {
    el('select-error').textContent =
      `${ontbrekend} aangevinkt${ontbrekend === 1 ? ' formulier is' : 'e formulieren zijn'} ` +
      'niet in dit project gevonden. Ververs de Forma Build-pagina en probeer opnieuw.';
    el('select-error').hidden = false;
  }
}

// -----------------------------------------------------------------------------
// Stap 3 — stempelen
// -----------------------------------------------------------------------------

const VINKJE = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>';
const KRUISJE = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function runRegelHtml(rij, actief) {
  const bolletje =
    rij.staat === 'klaar'
      ? `<div class="dot done">${VINKJE}</div>`
      : rij.staat === 'fout'
        ? `<div class="dot err">${KRUISJE}</div>`
        : rij.staat === 'bezig'
          ? '<div class="dot busy"></div>'
          : '<div class="dot pending"></div>';

  const fout = rij.staat === 'fout' ? ' style="color:#ed0500;opacity:1"' : '';
  const sub = rij.melding ? `<span class="sub"${fout}>${escapeHtml(rij.melding)}</span>` : '';

  // Punt 6: alleen zichtbaar bij het formulier waar het werkelijk gebeurde.
  const verloren = rij.verlorenTekst
    ? `<span class="lost-text">Let op: tekst onder het assetblok is vervangen</span>`
    : '';

  return (
    `<div class="run-item${actief ? ' actief' : ''}">${bolletje}` +
    `<div class="txt">#${rij.formNum ?? '—'} - ${escapeHtml(rij.naam)}${sub}${verloren}</div></div>`
  );
}

function tekenRun() {
  const run = staat.run;
  if (!run) return;

  const gedaan = run.rijen.filter((r) => r.staat !== 'wacht' && r.staat !== 'bezig').length;
  const fouten = run.rijen.filter((r) => r.staat === 'fout').length;
  const geschreven = run.rijen.filter((r) => r.staat === 'klaar' && r.geschreven).length;
  const overgeslagen = run.rijen.filter((r) => r.staat === 'klaar' && !r.geschreven).length;
  const heropend = run.rijen.filter((r) => r.heropend).length;

  el('stamp-rows').innerHTML = run.rijen
    .map((rij) => runRegelHtml(rij, rij.staat === 'bezig'))
    .join('');

  if (run.klaar) {
    el('stamp-title').textContent = fouten > 0 ? `Klaar, met ${fouten} fout${fouten === 1 ? '' : 'en'}` : 'Klaar met stempelen';
    const delen = [`${geschreven} bijgewerkt`];
    if (overgeslagen > 0) delen.push(`${overgeslagen} overgeslagen (ongewijzigd)`);
    if (heropend > 0) delen.push(`${heropend} gesloten formulieren heropend`);
    if (fouten > 0) delen.push(`${fouten} fout - opnieuw proberen mogelijk`);
    el('stamp-summary').textContent = delen.join(' · ');
  } else {
    el('stamp-title').textContent = 'Bezig met stempelen';
    el('stamp-summary').textContent = `${gedaan} van ${run.rijen.length} formulieren verwerkt`;
  }

  // Halverwege stoppen, of achteraf de mislukte opnieuw proberen.
  const links = el('btn-stamp-secondary');
  if (run.klaar) {
    links.textContent = fouten > 0 ? `${fouten} fout opnieuw proberen` : 'Annuleren';
    links.disabled = fouten === 0;
  } else {
    links.textContent = 'Annuleren';
    links.disabled = false;
  }

  el('btn-to-summary').disabled = !run.klaar;

  // De actieve rij in beeld houden; oudere regels blijven bereikbaar door
  // omhoog te scrollen.
  const actief = el('stamp-rows').querySelector('.actief');
  if (actief) actief.scrollIntoView({ block: 'nearest' });
}

/**
 * Werkt de rijen af, één voor één, in selectievolgorde.
 *
 * Stopt bij `afgebroken` (de gebruiker klikte Annuleren) en bij een token dat
 * niet meer te vernieuwen is. Dat tweede stuurt terug naar Inloggen — zie
 * `naarLogin` voor waarom dat hier geen verlies is.
 */
async function verwerkRun() {
  const run = staat.run;

  for (const rij of run.rijen) {
    if (run.afgebroken) break;
    if (rij.staat === 'klaar' || rij.staat === 'fout') continue;

    rij.staat = 'bezig';
    rij.melding = 'Bezig…';
    tekenRun();

    try {
      const entry = await vraag('stampForm', {
        runId: run.id,
        projectId: staat.projectId,
        formId: rij.formId,
        heropenen: staat.geslotenAan,
      });

      rij.staat = entry.resultaat === 'fout' ? 'fout' : 'klaar';
      rij.geschreven = entry.resultaat === 'geschreven';
      rij.melding = entry.melding;
      rij.heropend = Boolean(entry.heropend);
      rij.verlorenTekst = entry.verlorenTekst;
    } catch (fout) {
      if (fout.needsSignIn) {
        const gedaan = run.rijen.filter((r) => r.staat === 'klaar').length;
        naarLogin(
          `Je aanmelding is verlopen. ${gedaan} van de ${run.rijen.length} formulieren ` +
            'waren al gestempeld; die worden na het opnieuw aanmelden overgeslagen.',
        );
        return;
      }
      rij.staat = 'fout';
      rij.melding = `Fout: ${fout.message}`;
    }

    tekenRun();
  }

  run.klaar = true;
  tekenRun();
}

/** Begint een uitvoering over alles wat bij de huidige instellingen geschreven wordt. */
async function startRun() {
  const teStempelen = staat.formulieren.filter(wordtGestempeld);
  if (teStempelen.length === 0) return;

  const { runId } = await vraag('startRun', {
    projectId: staat.projectId,
    projectNaam: staat.projectNaam,
  });

  staat.run = {
    id: runId,
    rijen: teStempelen.map((f) => ({
      formId: f.id,
      formNum: f.formNum,
      naam: f.naam,
      staat: 'wacht',
      melding: '',
    })),
    klaar: false,
    afgebroken: false,
  };

  toon('stamp');
  tekenRun();
  await verwerkRun();
}

el('btn-stamp-secondary').addEventListener('click', async () => {
  const run = staat.run;
  if (!run) return;

  // Klaar met fouten: alleen die opnieuw proberen, niet de hele batch.
  if (run.klaar) {
    const fouten = run.rijen.filter((r) => r.staat === 'fout');
    if (fouten.length === 0) return;
    for (const rij of fouten) {
      rij.staat = 'wacht';
      rij.melding = '';
    }
    run.klaar = false;
    await verwerkRun();
    return;
  }

  // Halverwege: stoppen. Wat geschreven is, blijft staan.
  run.afgebroken = true;
  run.klaar = true;
  tekenRun();
});

el('btn-to-summary').addEventListener('click', () => toonSamenvatting());

// -----------------------------------------------------------------------------
// Stap 4 — samenvatting en ongedaan maken
// -----------------------------------------------------------------------------

/** "zojuist", "3 dagen geleden" — grof, want preciezer helpt hier niemand. */
function relatieveTijd(iso) {
  const seconden = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconden < 90) return 'zojuist';

  const stappen = [
    [60, 'minuut', 'minuten'],
    [24, 'uur', 'uur'],
    [30, 'dag', 'dagen'],
    [12, 'mnd', 'mnd'],
  ];

  let waarde = seconden / 60;
  for (const [factor, enkel, meervoud] of stappen) {
    if (waarde < factor || factor === 12) {
      const n = Math.floor(waarde);
      return `${n} ${n === 1 ? enkel : meervoud} geleden`;
    }
    waarde /= factor;
  }
  return 'lang geleden';
}

function tijdstip(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function samenvattingVanRun(run) {
  const geschreven = run.formulieren.filter((f) => f.resultaat === 'geschreven');
  const overgeslagen = run.formulieren.filter((f) => f.resultaat === 'overgeslagen').length;
  const fouten = run.formulieren.filter((f) => f.resultaat === 'fout').length;

  const delen = [];
  // Bij één bijgewerkt formulier is de naam informatiever dan het getal.
  delen.push(
    geschreven.length === 1
      ? `1 bijgewerkt (${geschreven[0].naam})`
      : `${geschreven.length} bijgewerkt`,
  );
  if (overgeslagen > 0) delen.push(`${overgeslagen} overgeslagen`);
  if (fouten > 0) delen.push(`${fouten} mislukt`);
  return delen.join(' · ');
}

function journaalRegelHtml(run) {
  const terugTeDraaien = run.formulieren.some((f) => f.resultaat === 'geschreven');
  const knop = run.teruggedraaid
    ? '<span class="undo-done">Teruggedraaid</span>'
    : terugTeDraaien
      ? `<button class="undo-btn" data-run="${escapeHtml(run.id)}">Ongedaan maken</button>`
      : '';

  return (
    `<div class="journal-row${run.teruggedraaid ? ' undone' : ''}">` +
    `<div class="jh"><span class="jname">${tijdstip(run.gestart)}</span>` +
    `<span class="jwhen">${relatieveTijd(run.gestart)}</span></div>` +
    `<div class="jmeta">${escapeHtml(samenvattingVanRun(run))}</div>${knop}</div>`
  );
}

async function toonSamenvatting() {
  toon('summary');
  el('summary-error').hidden = true;

  const { runs } = await vraag('getJournaal');
  const metInhoud = runs.filter((r) => r.formulieren.length > 0);

  el('summary-rows').innerHTML = metInhoud.length
    ? metInhoud.map(journaalRegelHtml).join('')
    : '<p class="hint">Nog geen uitvoeringen.</p>';
}

/** Het id van de uitvoering waar de dialoog nu over gaat. */
let undoDoel = null;

el('summary-rows').addEventListener('click', async (event) => {
  const knop = event.target.closest('.undo-btn');
  if (!knop) return;

  const { runs } = await vraag('getJournaal');
  const run = runs.find((r) => r.id === knop.dataset.run);
  if (!run) return;

  undoDoel = run.id;
  const aantal = run.formulieren.filter((f) => f.resultaat === 'geschreven').length;
  el('undo-text').textContent =
    `De opmerkingen van ${aantal} ${aantal === 1 ? 'formulier gaan' : 'formulieren gaan'} ` +
    'terug naar hoe ze waren.';

  // De onherstelbare kant alleen tonen als de run gesloten formulieren raakte.
  // Bij een gewone run is er niets onherstelbaars, en dan hoort die zin er niet
  // te staan.
  el('undo-warn').hidden = !run.formulieren.some((f) => f.heropend);
  el('undo-dialog').hidden = false;
});

el('btn-undo-cancel').addEventListener('click', () => {
  el('undo-dialog').hidden = true;
  undoDoel = null;
});

el('btn-undo-confirm').addEventListener('click', async () => {
  const knop = el('btn-undo-confirm');
  knop.disabled = true;
  knop.textContent = 'Bezig…';

  try {
    const { mislukt } = await vraag('undoRun', { runId: undoDoel });
    el('undo-dialog').hidden = true;
    await toonSamenvatting();


    if (mislukt.length > 0) {
      el('summary-error').textContent =
        `${mislukt.length} ${mislukt.length === 1 ? 'formulier is' : 'formulieren zijn'} ` +
        'niet teruggedraaid: ' + mislukt.map((m) => m.naam).join(', ');
      el('summary-error').hidden = false;
    }
  } catch (fout) {
    el('undo-dialog').hidden = true;
    // Terugdraaien schrijft ook, dus ook hier kan de aanmelding op zijn. Een
    // deel kan al teruggezet zijn; het journaal weet welk deel.
    if (fout.needsSignIn) {
      naarLogin('Je aanmelding is verlopen. Meld je opnieuw aan en probeer het terugdraaien nog eens.');
      return;
    }
    el('summary-error').textContent = fout.message;
    el('summary-error').hidden = false;
  } finally {
    knop.disabled = false;
    knop.textContent = 'Terugdraaien';
    undoDoel = null;
  }
});

el('btn-close').addEventListener('click', () => window.close());

el('btn-restart').addEventListener('click', async () => {
  staat.run = null;
  toon('select');
  await laadSelectie();
});

// -----------------------------------------------------------------------------
// Stap 1
// -----------------------------------------------------------------------------

function toonLogin(melding) {
  const regel = el('login-error');
  regel.textContent = melding ?? '';
  regel.hidden = !melding;
  toon('login');
}

/**
 * Terug naar Inloggen, omdat er niet meer namens de gebruiker gewerkt kan worden.
 *
 * Dit is de enige afhandeling van een dood refresh token, waar in de tool het
 * ook gebeurt. Twee redenen om niet te proberen ter plekke opnieuw aan te melden:
 *
 *   1. **Het kan niet.** Aanmelden opent een venster van Autodesk, de popup
 *      verliest de aandacht, en een popup die de aandacht verliest sluit. Alles
 *      wat alleen in het geheugen van de popup stond, is dan weg — inclusief een
 *      halve uitvoering.
 *   2. **Het hoeft niet.** Het stempel is idempotent: een formulier waarvan de
 *      assetregel al klopt, levert "ongewijzigd" op en wordt overgeslagen.
 *      Opnieuw beginnen ís dus hervatten, zonder dat er iets bewaard hoeft te
 *      blijven. En wat al geschreven was, staat per formulier in het journaal en
 *      blijft terug te draaien.
 */
function naarLogin(melding) {
  staat.run = null;
  toonLogin(melding);
}

el('btn-login').addEventListener('click', async () => {
  const knop = el('btn-login');
  knop.disabled = true;
  knop.textContent = 'Bezig met inloggen…';
  el('login-error').hidden = true;

  try {
    await vraag('signIn');
    toon('select');
    await laadSelectie();
  } catch (fout) {
    toonLogin(`Inloggen mislukt — ${fout.message}`);
  } finally {
    knop.disabled = false;
    knop.textContent = 'Inloggen bij Autodesk →';
  }
});

/**
 * Uitloggen. Geen bevestiging: de knop zegt nu wat hij doet.
 *
 * Toen hier "Terug" stond was een tussenvraag nodig, omdat niemand verwacht dat
 * "Terug" je afmeldt. Met het juiste woord op de knop is die vraag alleen nog
 * een extra klik — en opnieuw inloggen is geen straf.
 */
el('btn-logout').addEventListener('click', async () => {
  await vraag('signOut');
  staat.formulieren = [];
  staat.run = null;
  toonLogin();
});

el('closed-toggle').addEventListener('click', () => {
  staat.geslotenAan = !staat.geslotenAan;
  tekenSelectie();
});

el('btn-stamp').addEventListener('click', async () => {
  el('btn-stamp').disabled = true;
  try {
    await startRun();
  } catch (fout) {
    el('select-error').textContent = fout.message;
    el('select-error').hidden = false;
    el('btn-stamp').disabled = false;
  }
});

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

(async () => {
  try {
    const { signedIn } = await vraag('status');
    if (!signedIn) {
      toonLogin();
      return;
    }
    toon('select');
    await laadSelectie();
  } catch (fout) {
    toonLogin(fout.message);
  }
})();
