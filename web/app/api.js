/*
 * The JSON API of CI-Plane, through the Z-Dash server's shell
 * (/z-dash/server/api.js): every request that changes something carries the
 * header X-Z-Dash, which the server requires against cross-site requests,
 * and a failed request rejects with an ApiError whose message is meant for
 * the user, as the server wrote it. A 401 is the shell's: it shows the
 * sign-in card. The live change notices are the shell's too (on() of
 * /z-dash/server/shell.js, wired in main.js).
 */

import { request } from '/z-dash/server/api.js';

export { ApiError, request, get, post, put, del } from '/z-dash/server/api.js';

export const patch = (path, body = {}) => request('PATCH', path, body);
