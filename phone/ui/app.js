// Triple Re Mobile Eraser — screens. Polls the local station every second and draws:
// licence -> job details -> devices (select, erase, progress, result) and the reports list.
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = null;
let view = null;          // 'licence' | 'job' | 'devices' | 'reports'
let editingJob = false;
let showReports = false;
const selected = new Set();
let lastHtml = '';
let licError = '';

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TripleRe': '1' }, body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.error || 'حصلت مشكلة. جرّب تاني.');
  return data;
}

// ------------------------------------------------------------------ icons
const ICONS = {
  iphone: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6"><rect x="13" y="3" width="22" height="42" rx="5"/><path d="M21 8h6"/><circle cx="24" cy="39" r="1.5" fill="currentColor"/></svg>',
  ipad: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6"><rect x="7" y="4" width="34" height="40" rx="4"/><circle cx="24" cy="39.5" r="1.5" fill="currentColor"/></svg>',
  android: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6"><rect x="12" y="3" width="24" height="42" rx="4"/><path d="M12 9h24M12 38h24"/></svg>',
  plug: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="15" y="2" width="18" height="30" rx="4"/><path d="M24 32v8M18 46h12M24 40c0 4-6 3-6 6"/></svg>',
};

// ------------------------------------------------------------------ header
function pills() {
  const p = [];
  const l = state.licence;
  if (l.state === 'valid') p.push(`<span class="pill" title="${esc(l.name)}">مرخّص لحد ${esc(l.expires)}</span>`);
  else p.push(`<span class="pill bad">مفيش ترخيص</span>`);
  if (state.status.online === true) p.push('<span class="pill">متصل بالـ ERP</span>');
  else if (state.status.online === false) p.push('<span class="pill warn">مفيش اتصال</span>');
  if (state.pending) p.push(`<span class="pill warn">${state.pending} تقرير مستني رفع</span>`);
  $('#pills').innerHTML = p.join('');

  const b = [];
  if (state.status.windows && state.status.iosTools && !state.status.apple) {
    b.push(`<div class="banner"><div><b>علشان الآيفون والآيباد يشتغلوا:</b> لازم برنامج <b>Apple Devices</b> (مجاني من Microsoft Store) أو iTunes يكون متسطب على الكمبيوتر ده. سامسونج والأندرويد شغالين عادي.</div>
      <button class="btn small" data-act="apple">تسطيب Apple Devices</button></div>`);
  }
  const bannerHtml = b.join('');
  if ($('#banner').innerHTML !== bannerHtml) $('#banner').innerHTML = bannerHtml;
}

// ------------------------------------------------------------------ screens
function licenceScreen() {
  const l = state.licence;
  const why = {
    missing: ['البرنامج ده مش مفعّل', 'اعمل مفتاح للكمبيوتر ده من الـ ERP (صفحة شهادات مسح البيانات) ونزّل ملف upload.conf، وبعدين استورده من هنا.'],
    expired: ['الترخيص انتهى', `الترخيص كان صالح لحد ${esc(l.expires)}. وصّل الكمبيوتر بالنت ودوس "جدد الترخيص"، أو استورد upload.conf جديد.`],
    invalid: ['الترخيص مش سليم', 'ملف الترخيص اتعدّل أو مش من الـ ERP بتاعنا. استورد upload.conf جديد من الـ ERP.'],
  }[l.state] || ['الترخيص مش سليم', ''];
  return `<div class="card center-card">
    <div class="icon-circle bad">✕</div>
    <h1>${why[0]}</h1>
    <p>${why[1]}</p>
    <div class="row" style="justify-content:center;margin-top:22px">
      <button class="btn primary" data-act="import">استورد upload.conf</button>
      ${l.hasKey ? '<button class="btn" data-act="renew">جدد الترخيص</button>' : ''}
    </div>
    <input type="file" id="conf-file" accept=".conf,.txt,text/plain" hidden>
    <div class="error" id="lic-error">${esc(licError)}</div>
  </div>`;
}

function jobScreen() {
  const j = state.job;
  return `<form class="form card" id="job-form" autocomplete="off">
    <h1>بيانات الشغلانة</h1>
    <div class="sub">البيانات دي بتتكتب في شهادة المسح لكل جهاز.</div>
    <div class="field"><label for="client">اسم العميل</label><input id="client" name="client_name" value="${esc(j.client_name)}" required maxlength="120"></div>
    <div class="field"><label for="tech">اسم الفني</label><input id="tech" name="technician_name" value="${esc(j.technician_name)}" required maxlength="80"></div>
    <div class="field"><label for="wo">رقم أمر الشغل <span class="opt">(اختياري)</span></label><input id="wo" name="work_order" value="${esc(j.work_order)}" maxlength="60"></div>
    <div class="row"><button class="btn primary" type="submit">التالي</button>
    ${j.client_name && j.technician_name ? '<button class="btn" type="button" data-act="job-cancel">رجوع</button>' : ''}</div>
    <div class="error" id="job-error"></div>
  </form>`;
}

const STATE_LABEL = {
  preparing: 'بيجهّز', 'waiting-recovery': 'مستني Recovery', downloading: 'بيحمّل iOS', erasing: 'بيتمسح',
  rebooting: 'بيعيد التشغيل', 'awaiting-confirm': 'مستني تأكيدك', uploading: 'بيرفع التقرير', done: 'خلص', failed: 'فشل',
};
const BUSY = new Set(['preparing', 'waiting-recovery', 'downloading', 'erasing', 'rebooting', 'awaiting-confirm', 'uploading']);
const selectable = (d) => d.connected && !BUSY.has(d.job.state) && !(d.platform === 'ios' && !state.status.apple);

function readiness(d) {
  if (d.platform === 'ios') {
    if (d.mode === 'recovery' || d.mode === 'dfu') return ['في وضع Recovery — جاهز', ''];
    if (d.mode === 'locked') return ['مقفول — هيتمسح برضه', 'warn'];
    if (d.info.findMy === 'on') return ['Find My شغّال', 'bad'];
    return ['جاهز', ''];
  }
  if (d.mode === 'unauthorized') return ['اضغط Allow على الموبايل', 'warn'];
  if (d.mode === 'manual') return ['مقفول — مسح يدوي', 'warn'];
  if (d.mode === 'bootloader') return ['وضع Bootloader', 'warn'];
  if (d.mode === 'recovery') return ['في وضع Recovery', 'warn'];
  if (d.info.accounts && (d.info.accounts.google || d.info.accounts.samsung)) return ['عليه حساب Google/Samsung', 'bad'];
  return ['جاهز', ''];
}

function deviceCard(d) {
  const kind = d.kind || (d.platform === 'ios' ? 'iphone' : 'android');
  const on = selected.has(d.id) && selectable(d);
  const meta = [
    d.info.os, d.info.capacity, d.info.serial && `S/N ${d.info.serial}`, d.info.imei && `IMEI ${d.info.imei}`,
  ].filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('');
  const j = d.job;
  let side, body = '';
  if (BUSY.has(j.state)) {
    side = `<span class="badge busy">${STATE_LABEL[j.state]}</span>`;
    body += `<div class="progress"><div style="width:${Math.round((j.progress || 0.03) * 100)}%"></div></div>`;
    body += `<div class="msg">${esc(j.step ? `${j.step} — ` : '')}${esc(j.message || '')}</div>`;
    if (j.state === 'waiting-recovery' && d.recoverySteps) {
      body += `<ol class="steps">${d.recoverySteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
    }
    if (j.state === 'awaiting-confirm') body += `<div class="row" style="margin-top:10px"><button class="btn primary" data-act="confirm" data-id="${esc(d.id)}">تم المسح — اعمل التقرير</button></div>`;
  } else if (j.state === 'done') {
    const certs = (j.certificates || []).map((c) => c.number).filter(Boolean);
    side = `<span class="badge">${j.upload?.ok ? 'اتمسح ✓' : 'اتمسح — التقرير محفوظ'}</span>`;
    body += j.upload?.ok
      ? `<div class="certs">${certs.length ? `رقم الشهادة: ${esc(certs.join('، '))}` : esc(j.upload.message)}</div>`
      : `<div class="certs bad">${esc(j.upload?.message || '')}</div>`;
  } else if (j.state === 'failed') {
    side = `<span class="badge bad">فشل</span>`;
    body += `<div class="msg bad">${esc(j.message)}</div>`;
  } else {
    const [txt, cls] = readiness(d);
    side = `<span class="badge ${cls}">${esc(txt)}</span>`;
    if (d.platform === 'ios' && d.mode === 'locked') body += `<div class="msg">لو تقدر تفتح القفل اضغط "Trust" على الموبايل عشان نقرأ السيريال وحالة Find My. لو لأ، هيتمسح من وضع Recovery.</div>`;
    if (d.mode === 'unauthorized') body += `<div class="msg">على شاشة الموبايل: اضغط "Allow USB debugging". لو الموبايل مقفول، ضيفه بالسيريال وامسحه من الـ Recovery.</div>`;
  }
  if (!d.connected && BUSY.has(j.state) === false && j.state !== 'done') body += '<div class="msg">الجهاز اتفصل.</div>';
  if (j.log && j.log.length) body += `<details class="log"><summary>التفاصيل</summary><pre>${esc(j.log.join('\n'))}</pre></details>`;
  const dismiss = (['done', 'failed'].includes(j.state) || !d.connected) && !BUSY.has(j.state)
    ? `<button class="link" data-act="dismiss" data-id="${esc(d.id)}">شيله من القائمة</button>` : '';
  return `<div class="card dev ${on ? 'selected' : ''} ${d.connected ? '' : 'disconnected'}">
    <button class="check ${on ? 'on' : ''}" data-act="toggle" data-id="${esc(d.id)}" aria-pressed="${on}" ${selectable(d) ? '' : 'disabled'} aria-label="اختيار"></button>
    <div class="dev-icon">${ICONS[kind] || ICONS.android}</div>
    <div class="dev-body"><div class="dev-name">${esc(d.info.name || d.info.model || 'جهاز')}</div><div class="dev-meta">${meta}</div>${body}</div>
    <div class="dev-side">${side}${dismiss}</div>
  </div>`;
}

function devicesScreen() {
  const j = state.job;
  const list = state.devices.slice().sort((a, b) => String(a.firstSeen).localeCompare(String(b.firstSeen)));
  const chosen = list.filter((d) => selected.has(d.id) && selectable(d));
  const head = `<div class="row"><div><h1>اختار الأجهزة اللي هتتمسح</h1>
    <div class="sub">العميل: ${esc(j.client_name)} &nbsp; الفني: ${esc(j.technician_name)}${j.work_order ? ` &nbsp; أمر الشغل: ${esc(j.work_order)}` : ''}</div></div>
    <div class="spacer"></div><button class="btn" data-act="job-edit">تعديل بيانات الشغلانة</button></div>`;
  const body = list.length ? list.map(deviceCard).join('') : `<div class="empty">${ICONS.plug}
      <h2>وصّل الموبايل أو الآيباد بالكابل</h2><div>الجهاز هيظهر هنا لوحده خلال ثواني.</div>
      <div class="tips">
        <div class="tip"><b>آيفون / آيباد</b>افتح القفل واضغط "Trust". لو مقفول بباسورد أو ناسيينه، هيتمسح برضه من وضع Recovery.</div>
        <div class="tip"><b>سامسونج / أندرويد</b>فعّل USB debugging من Developer options واضغط "Allow". لو الموبايل مقفول، دوس "موبايل مقفول" تحت.</div>
      </div></div>`;
  const bottom = `<div class="bottom">
    <button class="btn" data-act="manual">موبايل أندرويد مقفول</button>
    <button class="btn" data-act="reports">التقارير</button>
    <div class="spacer"></div>
    <button class="btn danger" data-act="erase" ${chosen.length ? '' : 'disabled'}>${chosen.length ? `امسح ${chosen.length === 1 ? 'جهاز واحد' : chosen.length === 2 ? 'جهازين' : `${chosen.length} أجهزة`}` : 'اختار الأجهزة'}</button>
  </div>`;
  return head + body + bottom;
}

function reportsScreen() {
  const rows = state.history.map((h) => `<tr>
    <td class="ltr">${esc((h.completed || '').replace('T', ' ').replace('Z', ''))}</td>
    <td>${esc(h.name || h.model || '')}</td><td class="ltr">${esc(h.serial || '')}</td><td class="ltr">${esc(h.imei || '')}</td>
    <td>${esc(h.client)}</td><td>${esc(h.method || '')}</td>
    <td>${h.uploaded ? `<b style="color:var(--green-dark)">${esc(h.certificates.map((c) => c.number).join('، ') || 'اترفع')}</b>`
      : `<span style="color:var(--amber)">${esc(h.error)}</span> <button class="btn small" data-act="upload" data-id="${esc(h.id)}">ارفع</button>`}</td></tr>`).join('');
  return `<div class="row"><div><h1>التقارير</h1><div class="sub">كل الأجهزة اللي اتمسحت على الكمبيوتر ده.</div></div><div class="spacer"></div>
    ${state.pending ? `<button class="btn primary" data-act="retry">ارفع المتأخر (${state.pending})</button>` : ''}
    <button class="btn" data-act="open-reports">افتح فولدر التقارير</button><button class="btn" data-act="back">رجوع</button></div>
    ${rows ? `<table><thead><tr><th>الوقت (UTC)</th><th>الجهاز</th><th>السيريال</th><th>IMEI</th><th>العميل</th><th>طريقة المسح</th><th>الشهادة</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty"><h2>لسه مفيش تقارير</h2></div>'}`;
}

function render() {
  pills();
  const l = state.licence;
  const jobOk = state.job.client_name && state.job.technician_name;
  const next = l.state !== 'valid' ? 'licence' : (!jobOk || editingJob) ? 'job' : showReports ? 'reports' : 'devices';
  if (next === 'job' && view === 'job') return; // keep what the technician is typing
  if (next === 'licence' && view === 'licence') return;
  view = next;
  const html = { licence: licenceScreen, job: jobScreen, devices: devicesScreen, reports: reportsScreen }[view]();
  if (html !== lastHtml) {
    const openLogs = [...document.querySelectorAll('details.log[open]')].map((e) => e.closest('.dev')?.querySelector('[data-id]')?.dataset.id);
    $('#main').innerHTML = html;
    lastHtml = html;
    for (const id of openLogs) {
      const btn = document.querySelector(`.dev [data-id="${CSS.escape(id || '')}"]`);
      btn?.closest('.dev')?.querySelector('details.log')?.setAttribute('open', '');
    }
    if (view === 'job') $('#client')?.focus();
  }
  $('#hint').textContent = view === 'devices'
    ? 'وصّل كذا جهاز مع بعض لو عايز. علّم على الأجهزة ودوس امسح. متشيلش الكابل أثناء المسح.'
    : view === 'job' ? 'اكتب البيانات ودوس التالي.' : view === 'licence' ? 'الترخيص بيتجدد لوحده لما الكمبيوتر يكون متوصل بالنت.' : '';
}

async function poll() {
  try {
    state = await api('/api/state');
    if (!$('#confirm').open && !$('#manual').open) render();
    else pills();
  } catch { /* station restarting */ }
  setTimeout(poll, 1000);
}

// ------------------------------------------------------------------ dialogs
function openConfirm() {
  const list = state.devices.filter((d) => selected.has(d.id) && selectable(d));
  if (!list.length) return;
  const locks = list.filter((d) => d.needsAck);
  const dlg = $('#confirm');
  dlg.innerHTML = `<form method="dialog" class="inner">
    <h2>تأكيد المسح النهائي</h2>
    <div>الأجهزة دي هتتمسح بالكامل ومش هينفع ترجع أي بيانات منها:</div>
    <ul>${list.map((d) => `<li><b>${esc(d.info.name || d.info.model || d.id)}</b> ${d.info.serial ? `— S/N ${esc(d.info.serial)}` : ''}</li>`).join('')}</ul>
    ${locks.length ? `<div class="warnbox"><b>تحذير:</b> ${locks.map((d) => esc(d.info.name || d.id)).join('، ')}
      ${locks.some((d) => d.platform === 'ios') ? ' — Find My شغّال أو مش معروف: بعد المسح الجهاز هيطلب حساب Apple بتاع صاحبه (Activation Lock).' : ''}
      ${locks.some((d) => d.platform === 'android') ? ' — عليه حساب Google/Samsung أو مش معروف: بعد المسح هيطلب الحساب (FRP).' : ''}
      المسح نفسه سليم، بس الجهاز مش هيتباع غير لما صاحبه يشيل الحساب. ده هيتكتب في الشهادة.</div>
      <label class="ack"><input type="checkbox" id="ack"> فاهم، وعايز أمسح برضه</label>` : ''}
    <div class="error" id="confirm-error"></div>
    <div class="actions"><button class="btn" value="cancel" id="cancel-erase" autofocus>إلغاء</button>
      <button class="btn danger" type="button" id="go-erase">امسح نهائيًا</button></div></form>`;
  dlg.showModal();
  $('#cancel-erase').focus();
  $('#go-erase').onclick = async () => {
    const ack = $('#ack');
    if (ack && !ack.checked) { $('#confirm-error').textContent = 'علّم على "فاهم" الأول.'; return; }
    try {
      await api('/api/erase', { ids: list.map((d) => d.id), ackLocks: Boolean(ack?.checked) });
      for (const d of list) selected.delete(d.id);
      dlg.close();
      lastHtml = '';
    } catch (e) { $('#confirm-error').textContent = e.message; }
  };
}

function openManual() {
  const dlg = $('#manual');
  dlg.innerHTML = `<form class="inner" id="manual-form" autocomplete="off">
    <h2>موبايل أندرويد مقفول</h2>
    <div class="sub">لو الموبايل مقفول والكمبيوتر مش قادر يقراه: اكتب السيريال (من على ضهر الموبايل أو العلبة أو من Recovery)، وامسحه من الـ Recovery وأكّد هنا.</div>
    <div class="field"><label for="m-serial">السيريال</label><input id="m-serial" name="serial" required maxlength="40" dir="ltr"></div>
    <div class="field"><label for="m-man">الشركة <span class="opt">(اختياري)</span></label><input id="m-man" name="manufacturer" maxlength="30" dir="ltr" placeholder="Samsung"></div>
    <div class="field"><label for="m-model">الموديل <span class="opt">(اختياري)</span></label><input id="m-model" name="model" maxlength="60" dir="ltr" placeholder="SM-A546E"></div>
    <div class="field"><label for="m-imei">IMEI <span class="opt">(اختياري)</span></label><input id="m-imei" name="imei" maxlength="17" dir="ltr" inputmode="numeric"></div>
    <div class="error" id="manual-error"></div>
    <div class="actions"><button class="btn" type="button" id="manual-cancel">إلغاء</button><button class="btn primary" type="submit">ضيفه</button></div></form>`;
  dlg.showModal();
  $('#m-serial').focus();
  $('#manual-cancel').onclick = () => dlg.close();
  $('#manual-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    try {
      const r = await api('/api/manual', f);
      selected.add(r.id);
      dlg.close();
      lastHtml = '';
    } catch (e) { $('#manual-error').textContent = e.message; }
  };
}

// ------------------------------------------------------------------ actions
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const id = el.dataset.id;
  const act = el.dataset.act;
  try {
    if (act === 'toggle') { selected.has(id) ? selected.delete(id) : selected.add(id); lastHtml = ''; render(); return; }
    if (act === 'erase') return openConfirm();
    if (act === 'manual') return openManual();
    if (act === 'job-edit') { editingJob = true; view = null; lastHtml = ''; render(); return; }
    if (act === 'job-cancel') { editingJob = false; view = null; lastHtml = ''; render(); return; }
    if (act === 'reports') { showReports = true; lastHtml = ''; render(); return; }
    if (act === 'back') { showReports = false; lastHtml = ''; render(); return; }
    if (act === 'import') { $('#conf-file').click(); return; }
    if (act === 'renew') {
      const r = await api('/api/licence/renew', {});
      licError = r.licence.state === 'valid' ? '' : r.result === 'revoked' ? 'المفتاح ده اتوقف من الـ ERP.' : 'مقدرتش أجدد. اتأكد إن الكمبيوتر متوصل بالنت.';
      view = null; lastHtml = '';
      state = await api('/api/state'); render();
      return;
    }
    if (act === 'confirm') { el.disabled = true; await api('/api/confirm', { id }); return; }
    if (act === 'dismiss') { await api('/api/dismiss', { id }); selected.delete(id); return; }
    if (act === 'upload') { el.disabled = true; await api('/api/upload', { report: id }); return; }
    if (act === 'retry') { el.disabled = true; await api('/api/retry-uploads', {}); return; }
    if (act === 'apple') { await api('/api/open-apple-driver', {}); return; }
    if (act === 'open-reports') { await api('/api/open-reports', {}); return; }
  } catch (e) {
    alert(e.message);
  }
});

document.addEventListener('change', async (ev) => {
  if (ev.target.id !== 'conf-file') return;
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const r = await api('/api/licence/import', { text });
    licError = r.licence.state === 'valid' ? '' : r.licence.state === 'expired' ? 'الملف اتقرا، بس الترخيص اللي فيه منتهي. وصّل النت ودوس "جدد الترخيص".' : 'الملف اتقرا بس الترخيص مش سليم.';
    view = null; lastHtml = '';
  } catch (e) { licError = e.message; view = null; lastHtml = ''; }
  ev.target.value = '';
  render();
});

document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'job-form') return;
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(ev.target));
  if (!f.client_name.trim() || !f.technician_name.trim()) { $('#job-error').textContent = 'اكتب اسم العميل واسم الفني.'; return; }
  try {
    const r = await api('/api/job', f);
    state.job = r.job;
    editingJob = false; view = null; lastHtml = '';
    render();
  } catch (e) { $('#job-error').textContent = e.message; }
});

poll();
