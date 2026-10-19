import { detectionPage } from './detection.js';
export function fixtureServer(options: { hostname?: string } = {}) {
  const server = Bun.serve({
    hostname: options.hostname ?? '0.0.0.0',
    port: 0,
    fetch(request): Response {
      const u = new URL(request.url);
      const base = `http://127.0.0.1:${server.port}`;
      const cross = `http://localhost:${server.port}`;
      if (u.pathname === '/signals/ip')
        return Response.json({
          ip: server.requestIP(request)?.address,
          headers: {
            'user-agent': request.headers.get('user-agent'),
            'accept-language': request.headers.get('accept-language'),
          },
        });
      if (u.pathname === '/input-events') {
        const level = u.searchParams.get('level');
        const frames = !level
          ? `<iframe src="${base}/input-events?level=same"></iframe><iframe src="${cross}/input-events?level=cross"></iframe>`
          : level === 'cross'
            ? `<iframe src="${base}/input-events?level=nested"></iframe>`
            : '';
        return new Response(
          `<!doctype html><meta charset="utf-8"><style>body{margin:10px}input,button{margin:8px;width:140px;height:30px}iframe{display:block;width:530px;height:310px}#spacer{height:2000px}</style><input id="plain"><button id="target">Click</button><button id="moving">Move</button><div id="shadow"></div><select id="select"><option value="a">A</option><option value="b">B</option></select>${frames}<div id="spacer"></div><button id="bottom">Bottom</button><script>
        const root=document.querySelector('#shadow').attachShadow({mode:'closed'});root.innerHTML='<input id="closed-input">';
        window.__events=[];window.__clear=()=>window.__events=[];
        const record=e=>{if(window.__events.length>=5000)return;const p=e.composedPath()[0];window.__events.push({type:e.type,id:p.id,key:e.key,code:e.code,buttons:e.buttons,button:e.button,x:e.clientX,y:e.clientY,ctrl:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey,trusted:e.isTrusted,data:e.data,inputType:e.inputType,value:p.value,start:p.selectionStart,end:p.selectionEnd,time:performance.now()});};
        for(const type of ['mousemove','mousedown','mouseup','click','wheel','keydown','keyup','beforeinput','input','change','focus','blur','scroll'])document.addEventListener(type,record,true);
        root.addEventListener('input',record);root.addEventListener('keydown',record);
        window.__shiftOnMove=false;window.__coverOnMove=false;
        document.addEventListener('mousemove',()=>{if(window.__shiftOnMove){window.__shiftOnMove=false;document.querySelector('#moving').style.marginLeft='110px';}if(window.__coverOnMove){window.__coverOnMove=false;const cover=document.createElement('div');cover.id='cover';cover.style.cssText='position:fixed;inset:0;background:red;z-index:9999';document.body.append(cover);}});
        </script>`,
          { headers: { 'content-type': 'text/html;charset=utf-8' } },
        );
      }
      if (u.pathname === '/signals') {
        const level = u.searchParams.get('level');
        const frames = !level
          ? `<iframe src="${base}/signals?level=same"></iframe><iframe src="${cross}/signals?level=cross"></iframe>`
          : level === 'cross'
            ? `<iframe src="${base}/signals?level=nested"></iframe>`
            : '';
        return new Response(
          `<!doctype html><meta charset="utf-8"><style>p{font-size:20px}#latin{font-family:Arial,sans-serif}#cjk{font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif}#emoji{font-family:"Segoe UI Emoji","Noto Color Emoji",sans-serif}</style><p id="latin">Native font sample 0123</p><p id="cjk">中文字体采样</p><p id="emoji">😀🌏</p>${frames}`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      if (u.pathname === '/worker-blocked')
        return new Response('<!doctype html><p>Worker blocked by CSP</p>', {
          headers: {
            'content-type': 'text/html',
            'content-security-policy': "worker-src 'none'; script-src 'none'",
          },
        });
      if (u.pathname === '/mcp')
        return new Response(
          `<!doctype html><meta charset="utf-8">
        <label>Name <input id="name" oninput="document.querySelector('#echo').textContent=this.value"></label>
        <p id="echo">empty</p><label><input type="checkbox" id="check">Accept</label>
        <select id="choice" onchange="document.querySelector('#echo').textContent=this.value"><option value="a">A</option><option value="b">B</option></select>
        <button id="dialog" onclick="alert('test');this.textContent='done'">Dialog</button>
        <button id="delayed" onclick="setTimeout(()=>{const p=document.createElement('p');p.id='later';p.textContent='ready';document.body.append(p)},500)">Delay</button>`,
          { headers: { 'content-type': 'text/html' } },
        );
      if (u.pathname === '/audit') {
        const level = u.searchParams.get('level');
        const frames = !level
          ? `<iframe src="${base}/audit?level=same"></iframe><iframe src="${cross}/audit?level=cross"></iframe>`
          : level === 'cross' || level === 'churn'
            ? `<iframe src="${base}/audit?level=nested"></iframe>`
            : '';
        return new Response(detectionPage(frames), { headers: { 'content-type': 'text/html' } });
      }
      if (u.pathname === '/redirect') return Response.redirect(`${base}/page?redirected=1`, 302);
      if (u.pathname === '/download')
        return new Response('下载 fixture\n', {
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="fixture.txt"',
          },
        });
      if (u.pathname === '/json') return Response.json({ value: 42 });
      if (u.pathname === '/empty')
        return new Response('<html><body>empty</body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      if (u.pathname === '/frame')
        return new Response(
          `<!doctype html><style>body{margin:10px}button{width:120px;height:50px}</style><button id="frame-button" onclick="this.textContent='clicked'">frame</button><input id="frame-input"><script>globalThis.frameSecret='cross-main';</script><iframe id="nested" src="${base}/nested" style="display:block;width:250px;height:100px;border:3px solid"></iframe>`,
          { headers: { 'content-type': 'text/html' } },
        );
      if (u.pathname === '/nested')
        return new Response(
          '<button id="nested-button" onclick="this.textContent=\'nested-clicked\'">nested</button><script>globalThis.frameSecret="nested-main"</script>',
          { headers: { 'content-type': 'text/html' } },
        );
      if (u.pathname === '/same')
        return new Response(
          '<button id="same-button" onclick="this.textContent=\'same-clicked\'">same</button><input id="same-input"><script>globalThis.frameSecret="same-main"</script>',
          { headers: { 'content-type': 'text/html' } },
        );
      return new Response(
        `<!doctype html><meta charset="utf-8"><style>body{margin:12px}button{min-height:35px}iframe{display:block;width:420px;height:260px;border:7px solid;margin-top:10px}#cover{position:fixed;inset:0;background:#999;z-index:999}</style>
        <h1>Fixture 中文</h1><p id="target">small <b>needle</b></p><button id="button" onclick="this.textContent='clicked';globalThis.clicks++">Click</button>
        <input id="input"><textarea id="area"></textarea><div id="editable" contenteditable></div><input type="file" id="file" multiple>
        <select id="select" multiple><option value="a">A</option><option value="b">B</option></select>
        <div id="host"></div><a id="link" href="/empty">navigate</a><a id="spa" href="#changed">SPA</a><a id="download" href="/download">download</a>
        <button id="popup" onclick="window.open('/empty')">popup</button><script>globalThis.secret='main-secret';globalThis.clicks=0;globalThis.inputs=[];document.querySelector('#input').addEventListener('input', e=>inputs.push(e.target.value));const shadow=document.querySelector('#host').attachShadow({mode:'closed'});shadow.innerHTML='<button id="closed-button">Closed shadow</button><input id="closed-input">';shadow.querySelector('button').addEventListener('click',e=>e.target.textContent='shadow-clicked');</script>
        ${u.searchParams.has('frames') ? `<iframe id="same" src="${base}/same"></iframe><iframe id="cross" src="${cross}/frame"></iframe>` : ''}
        <div style="height:1200px"></div><button id="bottom" onclick="this.textContent='bottom-clicked'">bottom</button>`,
        { headers: { 'content-type': 'text/html' } },
      );
    },
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}
