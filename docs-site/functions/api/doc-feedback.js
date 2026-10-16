// CF Pages Function:接收文档站「这对我有帮助」反馈(同源,免 CORS),转发到
// Meadhall 的匿名反馈接口 /api/feedback/anon(免登录 + NSFW 预审 + IP 限流)。
const CENTRAL = 'https://rpg-roleplay.stellatrix.icu/api/feedback/anon';

export async function onRequestPost(context) {
  let body = {};
  try { body = await context.request.json(); } catch (_) { body = {}; }

  const helpful = body.helpful === true ? true : body.helpful === false ? false : null;
  const text = String(body.text || '').slice(0, 3500);
  const page = String(body.page || '').slice(0, 300);
  const lang = String(body.lang || '').slice(0, 8);

  // free_text 必填:把投票/正文组织成一条可读反馈
  let free_text = text;
  if (!free_text) free_text = helpful === true ? '文档反馈:有帮助' : helpful === false ? '文档反馈:没帮助' : '文档反馈';
  free_text = '[docs] ' + free_text + (page ? '\npage: ' + page : '');

  const payload = {
    free_text,
    client_id: 'docs-site',
    app_version: 'docs',
    env_snapshot: {
      source: 'docs',
      page,
      lang,
      helpful: helpful === true ? 'yes' : helpful === false ? 'no' : null,
    },
  };

  try {
    const resp = await fetch(CENTRAL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'meadhall-docs' },
      body: JSON.stringify(payload),
    });
    return new Response(JSON.stringify({ ok: resp.ok }), {
      status: resp.ok ? 200 : 502,
      headers: { 'content-type': 'application/json' },
    });
  } catch (_) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 502, headers: { 'content-type': 'application/json' },
    });
  }
}
