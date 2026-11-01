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

test('a switch gracefully closes old-provider sessions without interrupting them', async () => {
  const { createRegistry } = await import('../src/engine/registry');
  const registry = createRegistry();
  const cfg = { providers: { ownWork: 'subscription' as 'subscription' | 'codex' } };
  const ledger = openLedger(':memory:');
  const session = registry.add({ id: 'a', source: 'neo', folder: '/tmp', task: 'work', chatId: 1, createdAt: 0 });
  let closed = 0, interrupted = 0;
  registry.attachControl(session.id, { followUp() {}, interrupt: async () => { interrupted++; }, close: () => { closed++; }, tools: { provider: 'claude', running: () => [], background: async () => ({ ok: false }), stop: async () => ({ ok: false }) } } as never);
  const selection = createWorkerSdkSelection(cfg, ledger, registry);
  expect(selection.set('codex').ok).toBe(true);
  expect(closed).toBe(1);
  expect(interrupted).toBe(0);
});

test('switching never closes customer-driven sessions or re-closes draining sessions', async () => {
  const { createRegistry } = await import('../src/engine/registry');
  const registry = createRegistry();
  const cfg = { providers: { ownWork: 'subscription' as 'subscription' | 'codex' } };
  const makeSession = (id: string) => registry.add({ id, source: 'neo', folder: '/tmp', task: 'work', chatId: 1, createdAt: 0 });
  const customer = makeSession('customer'); registry.markCustomerDriven(customer.id);
  const draining = makeSession('draining');
  let closed = 0;
  const control = (alreadyClosed: boolean) => ({ followUp() {}, interrupt: async () => {}, closed: () => alreadyClosed, close: () => { closed++; } });
  registry.attachControl(customer.id, control(false));
  registry.attachControl(draining.id, control(true));
  expect(createWorkerSdkSelection(cfg, openLedger(':memory:'), registry).set('codex').ok).toBe(true);
  expect(closed).toBe(0);
});

test('a session that fails to close does not lose the saved choice', async () => {
  const { createRegistry } = await import('../src/engine/registry');
  const registry = createRegistry();
  const cfg = { providers: { ownWork: 'subscription' as 'subscription' | 'codex' } };
  const ledger = openLedger(':memory:');
  const session = registry.add({ id: 'blocked', source: 'neo', folder: '/tmp', task: 'work', chatId: 1, createdAt: 0 });
  registry.attachControl(session.id, { followUp() {}, interrupt: async () => {}, close: () => { throw new Error('cannot close'); } });
  expect(createWorkerSdkSelection(cfg, ledger, registry).set('codex').ok).toBe(true);
  expect(ledger.getMeta('worker_sdk_provider')?.value).toBe('codex');
});
