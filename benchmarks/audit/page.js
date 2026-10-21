// This exact probe runs in every group, including the no-CDP baseline.
async function environment() {
  const field = (value) =>
    value === undefined ? { status: 'unsupported' } : { status: 'observed', value };
  const nav = navigator;
  const result = Object.fromEntries(
    [
      'userAgent',
      'platform',
      'language',
      'languages',
      'hardwareConcurrency',
      'deviceMemory',
      'webdriver',
    ].map((k) => [k, field(nav[k])]),
  );
  result.timezone = field(Intl.DateTimeFormat().resolvedOptions().timeZone);
  result.secureContext = field(globalThis.isSecureContext);
  result.display =
    typeof document === 'undefined'
      ? { status: 'unsupported' }
      : field({
          screen: {
            width: screen.width,
            height: screen.height,
            availWidth: screen.availWidth,
            availHeight: screen.availHeight,
          },
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
          window: { screenX, screenY, outerWidth, outerHeight },
          visibility: document.visibilityState,
          focused: document.hasFocus(),
        });
  if (!nav.userAgentData) result.clientHints = { status: 'unsupported' };
  else {
    result.clientHints = { status: 'observed', lowEntropy: nav.userAgentData.toJSON() };
    try {
      result.clientHints.highEntropy = {
        status: 'observed',
        value: await nav.userAgentData.getHighEntropyValues([
          'architecture',
          'bitness',
          'model',
          'platformVersion',
          'fullVersionList',
          'wow64',
        ]),
      };
    } catch (error) {
      result.clientHints.highEntropy = { status: 'unavailable', error: String(error) };
    }
  }
  return result;
}
// Workers load this same file, without any injected navigator or native getter patch.
if (typeof document === 'undefined') {
  const sample = async (port, request, kind) => {
    const env = await environment();
    await fetch(`/headers?${new URLSearchParams({ ...request, context: kind })}`);
    port.postMessage({ status: 'observed', sampleId: request.sampleId, environment: env });
  };
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
    self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
    self.addEventListener('message', (event) =>
      event.waitUntil(sample(event.ports[0], event.data, 'service')),
    );
  } else if (
    typeof SharedWorkerGlobalScope !== 'undefined' &&
    self instanceof SharedWorkerGlobalScope
  ) {
    self.onconnect = (event) => {
      const port = event.ports[0];
      port.onmessage = (message) => void sample(port, message.data, 'shared');
      port.start();
    };
  } else self.onmessage = (message) => void sample(self, message.data, 'dedicated');
} else {
  const run = new URL(location.href).searchParams.get('run');
  const lifecycle = new URL(location.href).searchParams.get('life') || 'new';
  const events = [],
    mutations = [],
    ticks = [],
    frames = [];
  const initialGlobals = Object.getOwnPropertyNames(globalThis);
  const descriptor = (object) =>
    Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(object)).map(([key, d]) => [
        key,
        {
          configurable: d.configurable,
          enumerable: d.enumerable,
          writable: d.writable,
          type: typeof d.value,
          getter: d.get ? Function.prototype.toString.call(d.get) : null,
          setter: d.set ? Function.prototype.toString.call(d.set) : null,
        },
      ]),
    );
  for (const type of [
    'visibilitychange',
    'focus',
    'blur',
    'pagehide',
    'pageshow',
    'freeze',
    'resume',
    'pointerdown',
    'pointerup',
    'keydown',
    'keyup',
    'input',
    'click',
    'scroll',
  ])
    addEventListener(
      type,
      (e) => {
        if (events.length < 300)
          events.push({
            type,
            trusted: e.isTrusted,
            time: performance.now(),
            visibility: document.visibilityState,
            focused: document.hasFocus(),
          });
      },
      true,
    );
  const observer = new MutationObserver((records) => {
    for (const r of records)
      if (mutations.length < 300)
        mutations.push({
          type: r.type,
          node: r.target.nodeName,
          id: r.target.id,
          attribute: r.attributeName,
        });
  });
  observer.observe(document, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });
  let lastTick = performance.now(),
    lastFrame;
  const timer = setInterval(() => {
    const now = performance.now();
    if (ticks.length < 300) ticks.push(now - lastTick);
    lastTick = now;
  }, 50);
  let frameRequest;
  const raf = (now) => {
    if (lastFrame !== undefined && frames.length < 300) frames.push(now - lastFrame);
    lastFrame = now;
    frameRequest = requestAnimationFrame(raf);
  };
  frameRequest = requestAnimationFrame(raf);
  const deadline = async (task) => {
    let timer;
    try {
      return await Promise.race([
        task,
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ status: 'not-observed', reason: 'probe deadline 3000ms' }),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const workers = {};
  let dedicated, shared, registration;
  const message = async (target, request) => {
    const channel = new MessageChannel();
    try {
      return await deadline(
        new Promise((resolve) => {
          channel.port1.onmessage = (event) => {
            if (event.data.sampleId === request.sampleId) resolve(event.data);
          };
          target.postMessage(request, [channel.port2]);
        }),
      );
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  };
  async function sampleWorkers() {
    try {
      dedicated = new Worker('/probe.js');
    } catch (error) {
      workers.dedicated = {
        status: typeof Worker === 'undefined' ? 'unsupported' : 'unavailable',
        error: String(error),
      };
    }
    try {
      shared = new SharedWorker('/probe.js', `audit-${run}`);
      shared.port.start();
    } catch (error) {
      workers.shared = {
        status: typeof SharedWorker === 'undefined' ? 'unsupported' : 'unavailable',
        error: String(error),
      };
    }
    try {
      if (!navigator.serviceWorker) workers.service = { status: 'unsupported' };
      else {
        const previous = await navigator.serviceWorker.getRegistration();
        registration = await navigator.serviceWorker.register('/probe.js', { scope: `/r/${run}/` });
        const ready = await deadline(navigator.serviceWorker.ready);
        workers.service = ready.active ? { status: 'ready' } : ready;
        workers.service.lifecycle = {
          previousRegistration: !!previous,
          active: !!registration.active,
          controlled: !!navigator.serviceWorker.controller,
          controllerState: navigator.serviceWorker.controller?.state ?? null,
          page: lifecycle,
        };
      }
    } catch (error) {
      workers.service = { status: 'unavailable', error: String(error) };
    }
  }
  let sampleSequence = 0;
  async function refreshWorkers(phase) {
    const request = {
      run,
      phase,
      lifecycle,
      sampleId: `${lifecycle}:${phase}:${sampleSequence++}`,
    };
    for (const [kind, target] of [
      ['dedicated', dedicated],
      ['shared', shared?.port],
    ]) {
      if (!target) continue;
      try {
        workers[kind] = await deadline(
          new Promise((resolve) => {
            target.onmessage = (event) => {
              if (event.data.sampleId === request.sampleId) resolve(event.data);
            };
            target.onmessageerror = () =>
              resolve({ status: 'unavailable', error: 'message error' });
            target.postMessage(request);
          }),
        );
      } catch (error) {
        workers[kind] = { status: 'unavailable', error: String(error) };
      } finally {
        target.onmessage = target.onmessageerror = null;
      }
    }
    if (registration?.active) {
      const history = workers.service.lifecycle;
      try {
        workers.service = await message(registration.active, request);
      } catch (error) {
        workers.service = { status: 'unavailable', error: String(error) };
      }
      workers.service.lifecycle = {
        ...history,
        active: registration.active.state === 'activated',
        controlled: !!navigator.serviceWorker.controller,
        controllerState: navigator.serviceWorker.controller?.state ?? null,
      };
    }
  }
  let windowStart = performance.now();
  async function capture(phase) {
    await refreshWorkers(phase);
    await fetch(`/headers?${new URLSearchParams({ run, phase, lifecycle, context: 'document' })}`);
    const sample = {
      run,
      phase,
      lifecycle,
      time: performance.now(),
      environment: await environment(),
      workers,
      properties: {
        globals: Object.getOwnPropertyNames(globalThis),
        navigator: descriptor(Object.getPrototypeOf(navigator)),
        navigatorOwn: descriptor(navigator),
        window: descriptor(window),
        chrome: globalThis.chrome ? descriptor(globalThis.chrome) : null,
      },
      expectedDom: {
        input: document.querySelector('#name').value,
        clicks: Number(document.querySelector('#click').dataset.clicks || 0),
        scrollY,
      },
      sideEffects: {
        addedGlobals: Object.getOwnPropertyNames(globalThis).filter(
          (k) => !initialGlobals.includes(k),
        ),
        removedGlobals: initialGlobals.filter((k) => !Object.hasOwn(globalThis, k)),
        mutations: [...mutations],
      },
      lifecycleState: {
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        events: [...events],
      },
      timing: {
        samplingMs: performance.now() - windowStart,
        intervalMs: [...ticks],
        animationFrameMs: [...frames],
      },
    };
    await fetch('/report', {
      method: 'POST',
      body: JSON.stringify(sample),
      headers: { 'content-type': 'application/json' },
    });
    events.length = mutations.length = ticks.length = frames.length = 0;
    windowStart = performance.now();
  }
  void (async () => {
    await sampleWorkers();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await capture('ready');
    document.querySelector('#manual-capture').onclick = () => void capture('physical-input');
    document.querySelector('#manual-finish').onclick = async () => {
      await capture('physical-input');
      await fetch('/report', {
        method: 'POST',
        body: JSON.stringify({
          run,
          phase: 'manual-finish',
          physicalInput: document.querySelector('#physical-attest').checked
            ? 'user-attested; not independently verified'
            : 'not-verified',
        }),
      });
    };
    while (true) {
      const command = await (await fetch(`/command?run=${encodeURIComponent(run)}`)).json();
      if (command.phase === 'reload') {
        location.replace(`/r/${run}/page?run=${encodeURIComponent(run)}&life=controlled`);
        break;
      }
      if (command.phase === 'cleanup') {
        dedicated?.terminate();
        shared?.port.close();
        const regs = navigator.serviceWorker
          ? await navigator.serviceWorker.getRegistrations()
          : [];
        const owned = regs.filter((r) => r.scope === new URL(`/r/${run}/`, location.href).href);
        const unregistered = await Promise.all(owned.map((r) => r.unregister()));
        clearInterval(timer);
        cancelAnimationFrame(frameRequest);
        observer.disconnect();
        const remaining = navigator.serviceWorker
          ? await navigator.serviceWorker.getRegistrations()
          : [];
        await fetch('/report', {
          method: 'POST',
          body: JSON.stringify({
            run,
            phase: 'cleanup',
            unregistered,
            remainingRegistrations: remaining.filter(
              (r) => r.scope === new URL(`/r/${run}/`, location.href).href,
            ).length,
            dedicatedTerminated: !!dedicated,
            sharedClosed: !!shared,
            animationFrameCancelled: true,
          }),
          headers: { 'content-type': 'application/json' },
        });
        break;
      }
      if (command.phase) await capture(command.phase);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })().catch((error) =>
    fetch('/report', {
      method: 'POST',
      body: JSON.stringify({ run, phase: 'probe-error', error: String(error) }),
    }),
  );
}
