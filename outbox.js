// Hàng đợi gửi lại (Outbox) — khuôn TechOP-OS v1.2 (Hữu Bật, 09/11/2026)
// Chạy ở trang (không dựa Background Sync vì iOS Safari không có). Dùng được trong trình duyệt và Node (để test).
//
// Luật:
//  1. Ghi vào IndexedDB TRƯỚC lần gửi đầu, kèm client_tx_id sinh tại máy → mất mạng giữa chừng không mất dữ liệu,
//     gửi lại bao nhiêu lần máy chủ cũng chỉ tạo 1 đơn (UNIQUE client_tx_id).
//  2. Thử lại khi: lỗi mạng, 408, 429, 5xx. Chờ = ngẫu nhiên(0, min(5 phút, 2 giây × 2^lần)) ("full jitter");
//     có Retry-After thì chờ ít nhất bằng đó.
//  3. Không thử lại khi 4xx khác (dữ liệu sai): chuyển LOI ngay, báo người dùng. Quá 8 lần thử: cũng LOI.
//  4. Một lúc chỉ một lượt gửi (navigator.locks, nhiều tab cũng vậy).

export const BASE_MS = 2000, CAP_MS = 5 * 60 * 1000, MAX_LAN = 8;

export function tinhCho(lan, random = Math.random) {
  return Math.floor(random() * Math.min(CAP_MS, BASE_MS * 2 ** lan));
}

export function phanLoai(status) {
  if (status >= 200 && status < 300) return 'XONG';
  if (status === 408 || status === 429 || status >= 500) return 'THU_LAI';
  return 'LOI';
}

export function taoOutbox({ store, fetchFn = (...a) => fetch(...a), now = Date.now, random = Math.random, khoa } = {}) {
  let chuoi = Promise.resolve();
  const chayMotMinh = khoa || ((fn) => {
    if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('techop-outbox', fn);
    const p = chuoi.then(fn, fn); chuoi = p.catch(() => {}); return p;   // dự phòng: xếp hàng trong 1 tab
  });

  async function them(url, body) {
    if (!body || !body.client_tx_id) throw new Error('thiếu client_tx_id');
    const item = { client_tx_id: body.client_tx_id, url, body, status: 'CHO_GUI', lan: 0, gui_luc: 0, tao_luc: now() };
    await store.put(item);
    return item;
  }

  async function guiMot(item) {
    let status = 0, data = null, retryAfter = 0;
    try {
      const res = await fetchFn(item.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.body)
      });
      status = res.status;
      retryAfter = Number(res.headers.get('Retry-After')) || 0;
      try { data = await res.json(); } catch (_) { data = null; }
    } catch (_) { status = 0; }                                       // mất mạng / DNS / bị huỷ
    const loai = status === 0 ? 'THU_LAI' : phanLoai(status);
    if (loai === 'XONG') { await store.delete(item.client_tx_id); return { loai, item, data }; }
    if (loai === 'THU_LAI' && item.lan + 1 < MAX_LAN) {
      const lan = item.lan + 1;
      const cho = Math.max(retryAfter * 1000, tinhCho(lan, random));
      const moi = { ...item, lan, gui_luc: now() + cho, status_cuoi: status };
      await store.put(moi);
      return { loai, item: moi };
    }
    const hong = { ...item, status: 'LOI', status_cuoi: status, ma: data && data.ma || null, lan: item.lan + 1 };
    await store.put(hong);
    return { loai: 'LOI', item: hong, data };
  }

  // Gửi mọi mục đã đến giờ. Trả { xong, loi, cho, hen_luc } — hen_luc: lúc nên gọi lại (null nếu hết việc).
  async function xa() {
    return chayMotMinh(async () => {
      const kq = { xong: [], loi: [], cho: [], hen_luc: null };
      const ds = (await store.all()).filter(x => x.status === 'CHO_GUI').sort((a, b) => a.tao_luc - b.tao_luc);
      for (const it of ds) {
        if (it.gui_luc > now()) { kq.cho.push(it); continue; }
        const r = await guiMot(it);
        if (r.loai === 'XONG') kq.xong.push(r); else if (r.loai === 'LOI') kq.loi.push(r); else kq.cho.push(r.item);
      }
      const hen = kq.cho.map(x => x.gui_luc);
      kq.hen_luc = hen.length ? Math.min(...hen) : null;
      return kq;
    });
  }

  async function dangLoi() { return (await store.all()).filter(x => x.status === 'LOI'); }
  async function bo(txId) { await store.delete(txId); }
  return { them, xa, dangLoi, bo };
}

// Kho IndexedDB cho trình duyệt.
export function khoIndexedDB(ten = 'techop_outbox') {
  const mo = () => new Promise((ok, hong) => {
    const r = indexedDB.open(ten, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'client_tx_id' });
    r.onsuccess = () => ok(r.result); r.onerror = () => hong(r.error);
  });
  const lam = async (che, fn) => {
    const db = await mo();
    return new Promise((ok, hong) => {
      const tx = db.transaction('outbox', che); const st = tx.objectStore('outbox'); let kq;
      const req = fn(st); if (req) req.onsuccess = () => { kq = req.result; };
      tx.oncomplete = () => { db.close(); ok(kq); }; tx.onerror = () => { db.close(); hong(tx.error); };
    });
  };
  return {
    put: (v) => lam('readwrite', st => st.put(v)),
    delete: (k) => lam('readwrite', st => st.delete(k)),
    all: async () => (await lam('readonly', st => st.getAll())) || []
  };
}
