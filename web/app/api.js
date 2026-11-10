/*
 * The JSON API of CI-Plane and its live updates. Every request that changes
 * something carries the header X-CI-Plane, which the server requires
 * against cross-site requests. A failed request rejects with an ApiError
 * whose message is meant for the user, as the server wrote it.
 */

export class ApiError extends Error {
  constructor(status, message, fields = {}, body = {}) {
    super(message);
    this.status = status;
    this.fields = fields || {};
    this.body = body;
  }
}

let onUnauthorized = () => {};

/** Called when the server says the session is gone. */
export function whenSignedOut(handler) {
  onUnauthorized = handler;
}

export async function request(method, path, body) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (method !== 'GET') init.headers['X-CI-Plane'] = '1';
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError(0, 'CI-Plane does not answer. Check that it is running and that this computer can reach it.');
  }
  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') onUnauthorized();
    throw new ApiError(response.status, data.error || `The server answered ${response.status}. Try again.`, data.fields, data);
  }
  return data;
}

export const get = (path) => request('GET', path);
export const post = (path, body = {}) => request('POST', path, body);
export const put = (path, body = {}) => request('PUT', path, body);
export const patch = (path, body = {}) => request('PATCH', path, body);
export const del = (path) => request('DELETE', path);

/*
 * Live updates: the server sends "change" with the topics that moved
 * (state, tasks, live) and the page refetches what it shows. EventSource
 * reconnects by itself; onStatus tells whether the stream is up.
 */
export function live(onChange, onStatus = () => {}) {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => onStatus(true));
  source.addEventListener('error', () => onStatus(source.readyState === EventSource.OPEN));
  source.addEventListener('change', (event) => {
    try {
      onChange(new Set(JSON.parse(event.data).topics));
    } catch (error) {
      onChange(new Set(['state']));
    }
  });
  return source;
}
