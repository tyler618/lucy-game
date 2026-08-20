/**
 * Simulation worker. One slice of the round space, aggregated into exact
 * histograms rather than sampled statistics.
 *
 * Carry is a 2-decimal quantity bounded by MAX_CARRY, so the whole outcome
 * space is 1,000,001 distinct values (1.00x .. 10000.00x in hundredths). We
 * count every one of them. Everything the evidence file reports — RTP per
 * target, hit frequency per band, mean, median, max — is then derived exactly
 * from the histogram, with no bucketing error anywhere in the chain.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createHmac, createHash } from 'node:crypto';

const E52 = 2 ** 52;
const MAX_HUNDREDTHS = 1_000_000; // 10,000.00x
const { slice, rounds, moduli, clientSeed, roundsPerSeed } = workerData;

const hists = moduli.map(() => new Int32Array(MAX_HUNDREDTHS + 1));
const legacyHist = new Int32Array(MAX_HUNDREDTHS + 1);

let cappedCount = 0;
let maxUncappedHundredths = 0;
let maxUncappedH = 0;

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

let done = 0;
let seedOrdinal = 0;
const t0 = Date.now();

while (done < rounds) {
  // A fresh server seed every `roundsPerSeed` holes, mirroring production
  // rotation. Deterministic from the slice so the whole run reproduces.
  const serverSeed = sha(`ace-sim-v1|slice=${slice}|seed=${seedOrdinal++}`);
  const batch = Math.min(roundsPerSeed, rounds - done);

  for (let nonce = 1; nonce <= batch; nonce++) {
    const hex = createHmac('sha256', serverSeed).update(clientSeed + ':' + nonce, 'utf8').digest('hex');
    const h = parseInt(hex.slice(0, 13), 16);

    const denom = E52 - h;
    const invRaw = Math.floor((100 * E52) / denom);          // ACE: inverse CDF
    const legacyRaw = Math.floor((100 * E52 - h) / denom);   // bustabit comparison

    if (invRaw > maxUncappedHundredths) {
      maxUncappedHundredths = invRaw;
      maxUncappedH = h;
    }
    if (invRaw > MAX_HUNDREDTHS) cappedCount++;

    for (let m = 0; m < moduli.length; m++) {
      const v = h % moduli[m] === 0 ? 100 : invRaw > MAX_HUNDREDTHS ? MAX_HUNDREDTHS : invRaw;
      hists[m][v]++;
    }
    const lv = h % 101 === 0 ? 100 : legacyRaw > MAX_HUNDREDTHS ? MAX_HUNDREDTHS : legacyRaw;
    legacyHist[lv]++;
  }

  done += batch;
  if (seedOrdinal % 64 === 0) {
    parentPort.postMessage({ kind: 'progress', slice, done, rate: done / ((Date.now() - t0) / 1000) });
  }
}

parentPort.postMessage(
  {
    kind: 'result',
    slice,
    rounds: done,
    cappedCount,
    maxUncappedHundredths,
    maxUncappedH,
    hists: hists.map((x) => x.buffer),
    legacyHist: legacyHist.buffer,
  },
  [...hists.map((x) => x.buffer), legacyHist.buffer],
);
