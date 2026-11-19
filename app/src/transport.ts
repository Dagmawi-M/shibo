// The page talks to the engine through whichever host it is running in:
// a VS Code panel (messages) or the standalone local server (HTTP).
export interface Transport { send(msg: unknown): void; onMessage(cb: (msg: any) => void): void; onDown(cb: () => void): void; onUp(cb: () => void): void }

declare const acquireVsCodeApi: undefined | (() => { postMessage(m: unknown): void });

export function connect(): Transport {
  if (typeof acquireVsCodeApi === 'function') {
    const vscode = acquireVsCodeApi();
    return {
      send: (m) => vscode.postMessage(m),
      // A panel has no connect event, so the page asks for the project once it is listening.
      onMessage: (cb) => { window.addEventListener('message', (e) => cb(e.data)); vscode.postMessage({ t: 'hello' }); },
      onDown: () => {},
      onUp: () => {},
    };
  }
  const source = new EventSource('events');
  let down: () => void = () => {};
  source.onerror = () => down();
  return {
    send: (m) => { fetch('msg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) }).catch(() => down()); },
    onMessage: (cb) => { source.onmessage = (e) => cb(JSON.parse(e.data)); },
    onDown: (cb) => { down = cb; },
    onUp: (cb) => { source.onopen = () => cb(); },
  };
}
