import { addItem, listItems } from './routes/items.mjs';

const routes = {
  'GET /items': listItems,
  'POST /items': addItem,
};

export async function route(req) {
  const handler = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
  if (!handler) return { status: 404, body: { error: 'No such page.' } };
  return handler(req);
}
