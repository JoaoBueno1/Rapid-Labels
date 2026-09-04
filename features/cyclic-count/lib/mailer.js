'use strict';
/**
 * Envio de e-mail do Cyclic Count.
 *
 * SendGrid v3 pela REST, com `fetch`. SEM SDK de propósito: adicionar uma
 * dependência mexe em package.json, e mexer em package.json sem rodar
 * `npm install --package-lock-only` no MESMO commit aborta os 15 workflows
 * que rodam `npm ci`. Já aconteceu em 2026-08-07. O contrato do SendGrid aqui
 * é um POST com JSON — não vale o risco.
 *
 * Volume: 8 filiais x 4 semanas = 32/mes. O tier gratis e 100/dia.
 *
 * Nunca lanca por falha de envio. Devolve {ok:false, error} e quem chamou
 * grava em cc_email_log. Um disparo que morre no meio deixa a rodada num
 * limbo pior do que um e-mail que falhou e ficou registrado.
 */

const API = 'https://api.sendgrid.com/v3/mail/send';

const cfg = () => ({
  key:      process.env.SENDGRID_API_KEY || '',
  from:     process.env.CC_MAIL_FROM || process.env.NOTIFICATION_FROM_EMAIL || '',
  fromName: process.env.CC_MAIL_FROM_NAME || 'Rapid LED Inventory',
  replyTo:  process.env.CC_MAIL_REPLY_TO || '',
});

/** A tela pergunta isto para dizer "e-mail nao configurado" ANTES do disparo. */
function status() {
  const c = cfg();
  const missing = [];
  if (!c.key)  missing.push('SENDGRID_API_KEY');
  if (!c.from) missing.push('CC_MAIL_FROM');
  return { configured: missing.length === 0, missing, from: c.from, fromName: c.fromName };
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Envia para varios destinatarios em UMA mensagem, cada um vendo so o proprio
 * endereco. `personalizations` com uma entrada por pessoa e o que o SendGrid
 * oferece para isso — um `to` com a lista inteira vaza o e-mail de todo mundo
 * para todo mundo, e o pessoal do armazem nao precisa ver a caixa dos outros.
 */
async function send({ to, subject, text, html }) {
  const c = cfg();
  const st = status();
  if (!st.configured) return { ok: false, error: `E-mail nao configurado: falta ${st.missing.join(', ')}` };

  const list = (Array.isArray(to) ? to : [to]).map((e) => String(e || '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, error: 'Nenhum destinatario' };

  const body = {
    personalizations: list.map((email) => ({ to: [{ email }] })),
    from: { email: c.from, name: c.fromName },
    subject,
    content: [
      { type: 'text/plain', value: text || '' },
      ...(html ? [{ type: 'text/html', value: html }] : []),
    ],
  };
  if (c.replyTo) body.reply_to = { email: c.replyTo };

  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (r.status !== 202) {
      const t = await r.text();
      return { ok: false, error: `SendGrid ${r.status}: ${t.slice(0, 300)}`, to: list };
    }
    return { ok: true, providerId: r.headers.get('x-message-id') || null, to: list };
  } catch (e) {
    return { ok: false, error: `SendGrid: ${e.message}`, to: list };
  }
}

/**
 * O e-mail de disparo.
 *
 * Um paragrafo, um botao, e o prazo. Quem le isto esta no armazem, no celular,
 * e a unica coisa que precisa acontecer e o clique.
 */
function dispatchEmail({ branchName, weekLabel, listName, lines, dueLabel, url, snapshotLabel }) {
  const subject = `Stock Count — ${branchName} — week of ${weekLabel}`;

  const text = [
    `Hi ${branchName} team,`,
    '',
    `Your cyclic stock count for the week of ${weekLabel} is ready.`,
    `List: ${listName} — ${lines} item${lines === 1 ? '' : 's'}.`,
    dueLabel ? `Please complete it by ${dueLabel}.` : '',
    '',
    'Open your count sheet here:',
    url,
    '',
    `Each line shows the quantity our system holds for your warehouse as at ${snapshotLabel}.`,
    'Count what is physically on the shelf and type it in the box beside it.',
    '',
    'The link is just for your branch. It saves as you type.',
    '',
    'Thanks,',
    'Rapid LED Inventory',
  ].filter((l) => l !== null).join('\n');

  const html = `<!doctype html>
<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1b2a3f;max-width:560px;margin:0 auto;padding:24px">
  <p style="margin:0 0 16px">Hi ${esc(branchName)} team,</p>
  <p style="margin:0 0 16px">Your cyclic stock count for the week of <b>${esc(weekLabel)}</b> is ready.</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;font-size:14px">
    <tr><td style="padding:3px 16px 3px 0;color:#475569">List</td><td style="padding:3px 0"><b>${esc(listName)}</b></td></tr>
    <tr><td style="padding:3px 16px 3px 0;color:#475569">Items</td><td style="padding:3px 0"><b>${lines}</b></td></tr>
    ${dueLabel ? `<tr><td style="padding:3px 16px 3px 0;color:#475569">Due</td><td style="padding:3px 0"><b>${esc(dueLabel)}</b></td></tr>` : ''}
  </table>
  <p style="margin:0 0 24px">
    <a href="${esc(url)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;
       padding:11px 22px;border-radius:8px;font-weight:600;font-size:15px">Open the count sheet</a>
  </p>
  <p style="margin:0 0 16px;color:#475569;font-size:13.5px">
    Each line shows the quantity our system holds for your warehouse as at
    <b>${esc(snapshotLabel)}</b>. Count what is physically on the shelf and type it
    in the box beside it. The sheet saves as you type.
  </p>
  <p style="margin:0 0 4px;color:#64748b;font-size:12.5px">The link is just for your branch.</p>
  <p style="margin:0;color:#64748b;font-size:12.5px">If the button does not work, paste this into your browser:<br>
    <span style="word-break:break-all">${esc(url)}</span></p>
</div>`;

  return { subject, text, html };
}

module.exports = { send, status, dispatchEmail };
