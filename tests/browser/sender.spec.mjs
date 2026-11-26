// Who sent a person’s message (#1742): the server stamps it from who is asking, the one looking reads “You” over their
// own, and another person’s message has that person’s name. Sending keeps you as someone this Postbox knows without
// saving your profile. The person is the specs’ fixture (FIXTURE_PERSON), never a real account.

import { expect, test } from '@playwright/test';
import { People } from '../../server/people.mjs';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('sender');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('your message is stamped as yours and reads “You”, another person’s reads their name, and sending saves no profile', async ({ page }) => {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title: 'Who said it', personaIds: [arrange.persona(rt, 'librarian').id] });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  expect(Object.keys(rt.store.state.people), 'no one is kept before anything is sent').toEqual([]);
  // A message from before senders were kept, or typed in a terminal, names none: yours after it shares its “You” line.
  // Written as an item, with no turn: a reply to it could land between the two and give yours a line of its own.
  rt.threads.addItem(t.id, { kind: 'user', text: 'An older message', attachments: [], to: [] });
  await expect(page.locator('#main .turn.me', { hasText: 'An older message' }).locator('.who b')).toHaveText('You');
  await page.locator('#composer-input').fill('Hello from the page');
  await page.keyboard.press('Enter');
  const mine = page.locator('#main .turn.me', { hasText: 'Hello from the page' });
  await expect(mine).toBeVisible();
  await expect(mine.locator('.who'), 'one “You” line for both').toHaveCount(0);
  // Stamped by the server with the one asking, who is kept from then on with nothing saved.
  const [me] = Object.values(rt.store.state.people);
  const item = rt.store.items(t.id).find((i) => i.text === 'Hello from the page');
  expect([item?.personId, me.unsaved, me.profile]).toEqual([me.id, true, {}]);
  // Another person of this Postbox writes: their message has their name, on a line of its own.
  const people = new People({ store: rt.store });
  const sam = people.seen(people.of({ provider: 'oidc', issuer: 'https://idp.example', subject: 'u-2', username: 'sam', name: 'Sam Okafor' }));
  rt.sendMessage(t.id, { text: 'Hello from Sam' }, { id: sam.id });
  const theirs = page.locator('#main .turn.me', { hasText: 'Hello from Sam' });
  await expect(theirs.locator('.who b')).toHaveText('Sam Okafor');
  // Sending isn’t saving: your profile still starts from your account’s name, and says agents aren’t told it.
  await page.locator('header.topbar').getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await settled(page);
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(me.name);
  await expect(dialog.getByText('agents aren’t told it until you save')).toBeVisible();
});
