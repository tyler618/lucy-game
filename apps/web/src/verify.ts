/**
 * The public verifier.
 *
 * This page is the trust argument, so it has exactly one dependency — the same
 * `@ace/core` derivation the server settles with — and no network calls, no
 * storage, and no analytics. Save the page and it still works offline, which
 * is the point: a verifier you have to ask us to run for you is not a
 * verifier.
 *
 * The pure-JS SHA-256 in @ace/core exists for this file. It means the whole
 * proof is a few kilobytes of readable code rather than a WebCrypto promise
 * chain a player has to take on faith.
 */
import {
  HOUSE_EDGE_MODULO,
  MAX_CARRY,
  deriveHole,
  first52Bits,
  hashServerSeed,
  hmacHex,
  uncappedCarryFromHash,
  verifyServerSeed,
  yardsFor,
} from '@ace/core';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

/* Deep links from bet history prefill everything they can. */
const params = new URLSearchParams(location.search);
for (const [key, id] of [
  ['serverSeed', '#serverSeed'],
  ['clientSeed', '#clientSeed'],
  ['nonce', '#nonce'],
  ['serverSeedHash', '#expectHash'],
] as const) {
  const value = params.get(key);
  if (value) $<HTMLInputElement>(id).value = value;
}

function run(): void {
  const serverSeed = $<HTMLInputElement>('#serverSeed').value.trim();
  const clientSeed = $<HTMLInputElement>('#clientSeed').value.trim();
  const nonce = Number($<HTMLInputElement>('#nonce').value.trim());
  const expectHash = $<HTMLInputElement>('#expectHash').value.trim();

  if (!serverSeed) {
    alert('Paste a server seed. You get it when you rotate seeds — that is the whole point of rotation.');
    return;
  }
  if (!Number.isInteger(nonce) || nonce < 0) {
    alert('Nonce must be a whole number.');
    return;
  }

  const hole = deriveHole({ serverSeed, clientSeed, nonce });
  const h = first52Bits(hole.hash);

  $('#result').hidden = false;
  $('#out-carry').textContent = `${hole.carry.toFixed(2)}x`;
  $('#out-yards').textContent = `${yardsFor(hole.carry).toLocaleString()} yards`;
  $('#out-hash').textContent = hole.hash;
  $('#out-h').textContent = `${h.toLocaleString()}  (h % ${HOUSE_EDGE_MODULO} = ${h % HOUSE_EDGE_MODULO})`;
  $('#out-bust').textContent = h % HOUSE_EDGE_MODULO === 0 ? 'yes — forced to 1.00x' : 'no';
  $('#out-capped').textContent = hole.cappedAtMax
    ? `yes — raw curve gave ${uncappedCarryFromHash(h).toLocaleString()}x, clamped to ${MAX_CARRY.toLocaleString()}x`
    : 'no';

  const commit = $('#out-commit');
  if (expectHash) {
    const ok = verifyServerSeed(serverSeed, expectHash);
    commit.dataset.ok = String(ok);
    commit.textContent = ok
      ? 'Server seed matches the hash that was published before you played.'
      : 'MISMATCH — this seed is not the one that was committed. Do not trust this result.';
  } else {
    delete commit.dataset.ok;
    commit.textContent = `SHA-256 of this server seed: ${hashServerSeed(serverSeed)}`;
  }
}

function runRange(): void {
  const serverSeed = $<HTMLInputElement>('#serverSeed').value.trim();
  const clientSeed = $<HTMLInputElement>('#clientSeed').value.trim();
  const from = Math.max(0, Number($<HTMLInputElement>('#from').value));
  const to = Number($<HTMLInputElement>('#to').value);
  const out = $('#range-out');

  if (!serverSeed || !Number.isInteger(from) || !Number.isInteger(to) || to < from) {
    out.textContent = 'Give a server seed and a sane range.';
    return;
  }
  // Bounded so a fat-fingered range cannot lock the tab up. 500 holes is more
  // than any single seed rotation covers in practice.
  const end = Math.min(to, from + 500);

  const frag = document.createDocumentFragment();
  for (let n = from; n <= end; n++) {
    const carry = deriveHole({ serverSeed, clientSeed, nonce: n }).carry;
    const row = document.createElement('span');
    row.innerHTML = `<span>#${n}</span><b>${carry.toFixed(2)}x</b>`;
    frag.append(row);
  }
  out.replaceChildren(frag);
  if (end < to) {
    const note = document.createElement('span');
    note.textContent = `capped at ${end}`;
    out.append(note);
  }
}

$('#run').addEventListener('click', run);
$('#run-range').addEventListener('click', runRange);
for (const id of ['#serverSeed', '#clientSeed', '#nonce', '#expectHash']) {
  $<HTMLInputElement>(id).addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') run();
  });
}

/*
 * A worked example, so the page is useful before you have played a hole.
 * The nonce is chosen to land on a real carry rather than an instant bust — a
 * verifier whose first impression is "1.00x" reads as a broken page — and the
 * published hash is prefilled so the commitment check shows its passing state.
 */
if (!params.has('serverSeed')) {
  const exampleSeed = 'a'.repeat(64);
  $<HTMLInputElement>('#serverSeed').value = exampleSeed;
  $<HTMLInputElement>('#clientSeed').value = 'ace-example';
  $<HTMLInputElement>('#nonce').value = '5';
  $<HTMLInputElement>('#expectHash').value = hashServerSeed(exampleSeed);
  run();
}

$('#build').textContent = hmacHex('build', 'ace', 1).slice(0, 8);
