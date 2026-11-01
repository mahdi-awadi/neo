import { test, expect } from 'bun:test';
import { openLedger } from '../src/engine/ledger';
import { createWorkerSdkSelection } from '../src/engine/sdk-choice';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('provider selection survives a ledger reopen and invalid choices do not change it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'neo-sdk-choice-')), 'ledger.db');
  const ledger = openLedger(path);
  const cfg = { providers: { ownWork: 'subscription' as 'subscription' | 'codex' } };
  const selection = createWorkerSdkSelection(cfg, ledger);
  expect(selection.get()).toBe('subscription');
  expect(selection.set('codex').ok).toBe(true);
  expect(selection.set('gemini').ok).toBe(false);
  const fresh = { providers: { ownWork: 'subscription' as 'subscription' | 'codex' } };
  const restored = createWorkerSdkSelection(fresh, openLedger(path));
  expect(restored.get()).toBe('codex');
  expect(fresh.providers.ownWork).toBe('codex');
});

test('a storage failure leaves the chosen provider unchanged', () => {
  const cfg = { providers: { ownWork: 'subscription' as 'subscription' | 'codex' } };
  const selection = createWorkerSdkSelection(cfg, {
    getMeta: () => undefined,
    setMeta: () => { throw new Error('disk unavailable'); },
  });
  expect(selection.set('codex')).toMatchObject({ ok: false, sdk: { provider: 'subscription' } });
  expect(cfg.providers.ownWork).toBe('subscription');
});
