// Fixture code, served unchanged to all groups. The first statement captures synchronous
// properties before any await, fetch, timer or application callback in this fixture.
const initialEnvironment = {
  userAgent: navigator.userAgent,
  language: navigator.language,
  languages: [...navigator.languages],
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  clientHints: navigator.userAgentData?.toJSON() ?? null,
};
const query = new URL(location.href).searchParams;
const run = query.get('run');
const kind = query.get('kind');
const address = (path, context) => `${path}?${new URLSearchParams({ run, kind: context })}`;
const published = (async () => {
  let highEntropy;
  try {
    highEntropy = navigator.userAgentData
      ? {
          status: 'observed',
          value: await navigator.userAgentData.getHighEntropyValues([
            'architecture',
            'bitness',
            'model',
            'platformVersion',
            'fullVersionList',
            'wow64',
          ]),
        }
      : { status: 'unsupported' };
  } catch (error) {
    highEntropy = { status: 'unavailable', error: String(error) };
  }
  await fetch(address('/sample', kind), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initial: initialEnvironment, highEntropy }),
  });
})();

if (kind === 'document') {
  // Keep workers and ports alive until the owning temporary browser is closed.
  globalThis.fixtureWorkers = [
    new Worker(address('/worker.js', 'dedicated')),
    new SharedWorker(address('/worker.js', 'shared'), `environment-${run}`),
  ];
  fixtureWorkers[1].port.start();
  for (const context of ['same-frame', 'cross-frame']) {
    const frame = document.createElement('iframe');
    const url = new URL(address(`/r/${run}/frame`, context), location.href);
    if (context === 'cross-frame') url.hostname = 'localhost';
    frame.src = url.href;
    document.body.append(frame);
  }
  navigator.serviceWorker
    .register(address('/worker.js', 'service'), { scope: `/r/${run}/` })
    .catch((error) =>
      fetch(address('/failure', 'service'), { method: 'POST', body: String(error) }),
    );
} else if (kind === 'dedicated') {
  globalThis.nestedWorker = new Worker(address('/worker.js', 'nested'));
} else if (kind === 'shared') {
  self.onconnect = (event) => event.ports[0].start();
} else if (kind === 'service') {
  self.addEventListener('install', (event) =>
    event.waitUntil(published.then(() => self.skipWaiting())),
  );
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
}
