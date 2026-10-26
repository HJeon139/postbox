// What the install’s tests share (tests/remote-install*.test.mjs): the version, the host and the tar’s time.

import { defaultHostSettings } from '../shared/remote-settings.mjs';

export const VERSION = '0.10.0';
export const HOST = { id: 'ho_abc12345', name: 'host.example.com', settings: defaultHostSettings() };

export const MTIME = 1_700_000_000;
