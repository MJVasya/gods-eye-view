import test from 'node:test';
import assert from 'node:assert/strict';
import { bindClearLayersControl } from './clearLayersControl.js';

function fakeButton() {
  const listeners = new Map();
  return {
    _attrs: {},
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    getAttribute(name) {
      return this._attrs[name] ?? null;
    },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    },
    fire(type) {
      listeners.get(type)?.();
    },
  };
}

test('click runs the clear action and destroy detaches it', () => {
  const button = fakeButton();
  let calls = 0;
  const control = bindClearLayersControl(button, () => {
    calls += 1;
  });
  button.fire('click');
  assert.equal(calls, 1);
  control.destroy();
  button.fire('click');
  assert.equal(calls, 1);
});

test('clicks are ignored while the button reports busy', () => {
  const button = fakeButton();
  let calls = 0;
  const control = bindClearLayersControl(button, () => {
    calls += 1;
  });
  control.setBusy(true);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(
    button.getAttribute('aria-label'),
    'Clearing selected data layers',
  );
  button.fire('click');
  assert.equal(calls, 0);
  control.setBusy(false);
  button.fire('click');
  assert.equal(calls, 1);
  control.destroy();
});

test('a missing button degrades gracefully', () => {
  const control = bindClearLayersControl(null, () => {
    throw new Error('must not run');
  });
  control.setBusy(true);
  control.destroy();
});
