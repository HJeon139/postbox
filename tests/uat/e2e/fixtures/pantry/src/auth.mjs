import { timingSafeEqual } from 'node:crypto';

const TOKEN = Buffer.from(process.env.PANTRY_TOKEN ?? 'dev-token');

/** Whether the request carries the pantry’s token as `Authorization: Bearer <token>`. */
export function checkToken(req) {
  const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
  return given.length === TOKEN.length && timingSafeEqual(given, TOKEN);
}
