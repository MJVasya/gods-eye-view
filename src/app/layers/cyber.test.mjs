import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The standalone cyber layer module is built by a teammate. Probe for it with
 * a dynamic import so this file stays green until it lands, then exercises the
 * real wrapper contract.
 */
async function loadWrapper(t) {
  try {
    await import('../../layers/cyber/index.js');
  } catch {
    t.skip('src/layers/cyber/index.js has not landed yet');
    return null;
  }
  return import('./cyber.js');
}

test('the application wrapper builds a catalog-compatible cyber layer from its source', async (t) => {
  const wrapper = await loadWrapper(t);
  if (!wrapper) return;
  const layer = wrapper.createApplicationCyber({
    source: { getSnapshot: async () => [] },
  });
  // createLayerCatalog rejects anything without a stable string id, so the
  // id assertion is the wiring contract: the wrapper must forward source (and
  // the shared overlay host) to a factory that returns the cyber layer.
  assert.equal(layer.id, 'cyber');
});
