/**
 * Swap @ace/core onto node:crypto.
 *
 * The bundled pure-JS SHA-256 exists so the verifier runs in a bare browser.
 * On the server it would be the hottest function in the process, so we install
 * the native one at boot. Identical algorithm, identical bytes — and
 * `sha256.test.ts` pins the two implementations against each other so a
 * divergence fails CI rather than settling holes wrong.
 */
import { createHash, createHmac } from 'node:crypto';
import { setHmacBackend } from '@ace/core';

export function installNativeCrypto(): void {
  setHmacBackend({
    hmacSha256Hex: (key, msg) => createHmac('sha256', key).update(msg, 'utf8').digest('hex'),
    sha256Hex: (msg) => createHash('sha256').update(msg, 'utf8').digest('hex'),
  });
}
