// 本地 mock 微信 iLink 后端：喂一条消息、记录回复。
import http from 'node:http';

export function startMockIlink({ text, items, from = 'wxid_test_user' } = {}) {
  const sent = [];
  const typing = [];
  const queue = [];
  let served = false;
  let uploads = 0;
  let seq = 1;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const json = (o) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      const p = url.pathname;
      if (p.endsWith('/ilink/bot/getupdates')) {
        const buf = JSON.parse(body || '{}').get_updates_buf ?? '';
        if (!served && !buf) {
          served = true;
          queue.push(items ? { __items: items } : text);
        }
        if (queue.length > 0) {
          const msgs = queue.splice(0, queue.length).map((m) => ({
            message_id: String(1000 + seq),
            seq: seq++,
            from_user_id: from,
            to_user_id: 'bot-test',
            message_type: 1,
            message_state: 2,
            context_token: 'ctx-token-1',
            create_time_ms: Date.now(),
            item_list: typeof m === 'string' ? [{ type: 1, text_item: { text: m } }] : m.__items,
          }));
          return json({ ret: 0, get_updates_buf: `cursor-${seq}`, longpolling_timeout_ms: 5000, msgs });
        }
        setTimeout(() => json({ ret: 0, get_updates_buf: buf || 'cursor-1', msgs: [] }), 200);
        return;
      }
      if (p.endsWith('/ilink/bot/sendmessage')) {
        sent.push(JSON.parse(body || '{}'));
        return json({ ret: 0, message_id: String(9000 + sent.length) });
      }
      if (p.endsWith('/ilink/bot/getuploadurl')) {
        return json({ ret: 0, upload_full_url: `http://127.0.0.1:${server.address().port}/cdn/upload?x=1` });
      }
      if (p === '/cdn/upload') {
        uploads += 1;
        res.writeHead(200, { 'x-encrypted-param': 'ENC-PARAM' });
        res.end('ok');
        return;
      }
      if (p.endsWith('/ilink/bot/getconfig')) return json({ ret: 0, typing_ticket: 'ticket-1' });
      if (p.endsWith('/ilink/bot/sendtyping')) {
        typing.push(JSON.parse(body || '{}'));
        return json({ ret: 0 });
      }
      if (p.endsWith('/notifystart') || p.endsWith('/notifystop')) return json({ ret: 0 });
      res.writeHead(404);
      res.end('not found');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        sent,
        typing,
        push: (m) => queue.push(m),
        get uploads() { return uploads; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
