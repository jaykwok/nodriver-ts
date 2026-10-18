// This is a test page's own script, not a library init script. Keep its probes
// in a closure, and expose only the intentional __audit fixture interface.
function installProbe() {
  const state = { stackReads: 0, nameReads: 0, mutations: 0, clicks: 0, moves: 0 };
  const error = new Error('console serialization probe');
  Object.defineProperty(error, 'stack', {
    get() {
      state.stackReads++;
      return '';
    },
  });
  Object.defineProperty(error, 'name', {
    get() {
      state.nameReads++;
      return 'Error';
    },
  });
  const button = document.querySelector('button')!;
  const root = document.querySelector('#host')!.attachShadow({ mode: 'closed' });
  root.innerHTML = '<input id="closed-input">';
  button.addEventListener('click', () => state.clicks++);
  button.addEventListener('mousemove', () => state.moves++);
  const observer = new MutationObserver((records) => (state.mutations += records.length));
  const originals = [
    console.debug,
    Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')?.get,
  ];
  let globals: PropertyKey[] = [];
  let properties: PropertyKey[] = [];
  const api = {
    arm() {
      globals = Reflect.ownKeys(globalThis);
      properties = Reflect.ownKeys(button);
      observer.observe(document, { attributes: true, childList: true, subtree: true });
    },
    log() {
      console.debug(error);
    },
    readStack() {
      return error.stack;
    },
    sample() {
      return {
        ...state,
        globals: Reflect.ownKeys(globalThis)
          .filter((key) => !globals.includes(key))
          .map(String),
        properties: Reflect.ownKeys(button)
          .filter((key) => !properties.includes(key))
          .map(String),
        webdriver: navigator.webdriver,
        ownWebdriver: Object.hasOwn(navigator, 'webdriver'),
        nativeGetter: String(
          Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')?.get,
        ).includes('[native code]'),
        consoleUnchanged: console.debug === originals[0],
        getterUnchanged:
          Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')?.get === originals[1],
        userAgent: navigator.userAgent,
      };
    },
  };
  Object.defineProperty(globalThis, '__audit', { value: api });
  console.debug(error);
}

export function detectionPage(frames: string): string {
  return `<!doctype html><meta charset="utf-8"><style>iframe{display:block;width:420px;height:250px}button{width:120px;height:40px}</style><button id="probe-button">test</button><div id="host"></div>${frames}<script>(${installProbe.toString()})()</script>`;
}
