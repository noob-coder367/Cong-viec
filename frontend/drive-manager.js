(function () {
  const API = "https://cong-viec.onrender.com";
  const style = document.createElement("style");
  style.textContent = `
    #drive-open{border:1px solid #a78bfa66;background:#a78bfa12;color:#ddd6fe;border-radius:11px;padding:9px 11px;font-size:12px;white-space:nowrap}
    #drive-overlay{position:fixed;inset:0;z-index:9999;background:#030611d9;backdrop-filter:blur(10px);display:none;align-items:center;justify-content:center;padding:14px}
    #drive-panel{width:min(100%,1000px);height:min(850px,94dvh);display:flex;flex-direction:column;overflow:hidden;background:#0d1222;border:1px solid #ffffff20;border-radius:22px;box-shadow:0 25px 100px #000b;color:#f5f7ff;font:14px Inter,system-ui,sans-serif}
    #drive-panel *{box-sizing:border-box}#drive-panel button,#drive-panel input{font:inherit}#drive-panel button{cursor:pointer}
    .dv-head{display:flex;align-items:center;gap:12px;padding:17px 19px;border-bottom:1px solid #ffffff15}.dv-title{font-size:18px;font-weight:800;flex:1}.dv-muted{color:#929db7;font-size:12px}
    .dv-btn{border:1px solid #ffffff20;background:#ffffff08;color:#e2e8f0;border-radius:10px;padding:8px 11px;font-size:12px}.dv-primary{background:linear-gradient(135deg,#a78bfa,#67e8f9);color:#080b16;border:0;font-weight:750}
    .dv-tools{display:flex;flex-wrap:wrap;gap:8px;padding:13px 16px;border-bottom:1px solid #ffffff12}.dv-search{flex:1;min-width:150px;background:#080b16;border:1px solid #ffffff20;border-radius:10px;padding:9px 11px;color:#f5f7ff;outline:none}
    .dv-status{padding:9px 17px;color:#a5b4fc;font-size:12px;min-height:31px}.dv-list{overflow:auto;flex:1;padding:4px 12px 14px}.dv-row{display:flex;align-items:center;gap:10px;padding:11px 9px;border-bottom:1px solid #ffffff0b;border-radius:8px}.dv-row:hover{background:#ffffff08}.dv-icon{width:35px;height:35px;display:grid;place-items:center;border-radius:10px;background:#a78bfa15;font-size:17px;flex:none}.dv-file{min-width:0;flex:1}.dv-name{overflow-wrap:anywhere;font-weight:600;font-size:13px}.dv-sub{color:#8490aa;font-size:11px;margin-top:4px}.dv-actions{display:flex;flex-wrap:wrap;gap:5px}.dv-actions button{padding:6px 8px;font-size:11px}.dv-empty{padding:35px 12px;text-align:center;color:#929db7}.dv-foot{padding:10px 16px;border-top:1px solid #ffffff12;color:#7e8aa5;font-size:11px}
    #drive-pin-box{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:#080b16f2;padding:20px}.dv-pin-card{width:min(100%,360px);padding:25px;border-radius:18px;border:1px solid #ffffff20;background:#151b2e;text-align:center}.dv-pin-card h3{margin:0 0 8px}.dv-pin-card p{font-size:12px;color:#929db7;line-height:1.5}.dv-pin-card input{width:100%;padding:12px;border:1px solid #ffffff20;border-radius:10px;background:#080b16;color:#fff;text-align:center;letter-spacing:.3em;margin:9px 0 13px;outline:none}
    @media(max-width:600px){#drive-overlay{padding:0}#drive-panel{height:100dvh;width:100%;border-radius:0;border:0}.dv-head{padding:14px}.dv-tools{padding:10px}.dv-row{align-items:flex-start;flex-wrap:wrap}.dv-file{width:calc(100% - 48px);flex:auto}.dv-actions{width:100%;padding-left:45px}.dv-actions button{flex:1}.dv-title{font-size:16px}}
  `;
  document.head.appendChild(style);

  const openButton = document.createElement("button");
  openButton.id = "drive-open";
  openButton.type = "button";
  openButton.textContent = "Google Drive";
  const head = document.querySelector(".chat-head");
  if (head) head.insertBefore(openButton, document.getElementById("lock-btn"));

  const overlay = document.createElement("div");
  overlay.id = "drive-overlay";
  overlay.innerHTML = `
    <section id="drive-panel" role="dialog" aria-modal="true" aria-label="Quản lý Google Drive">
      <header class="dv-head"><div class="dv-icon">▤</div><div class="dv-title">Quản lý Google Drive<div class="dv-muted" id="dv-account">Khu vực riêng tư</div></div><button class="dv-btn" id="dv-close">Đóng</button></header>
      <div class="dv-tools">
        <input class="dv-search" id="dv-search" placeholder="Tìm tên file trong thư mục hiện tại..." aria-label="Tìm file">
        <button class="dv-btn dv-primary" id="dv-connect">Kết nối Google</button>
        <button class="dv-btn" id="dv-folder">＋ Thư mục</button>
        <button class="dv-btn" id="dv-upload">↑ Tải file</button>
        <button class="dv-btn" id="dv-trash-mode">Thùng rác</button>
        <input id="dv-file-input" type="file" hidden>
      </div>
      <div class="dv-status" id="dv-status" role="status">Đang kiểm tra kết nối...</div>
      <div class="dv-list" id="dv-list"><div class="dv-empty">Đang tải...</div></div>
      <footer class="dv-foot">Chỉ phiên Drive Admin mới được phép quản lý. Upload tối đa 25 MB mỗi file trong phiên bản đầu.</footer>
      <div id="drive-pin-box"><form class="dv-pin-card" id="dv-pin-form"><h3>Drive Admin</h3><p>Nhập PIN quản trị Drive riêng biệt. Không dùng PIN chat.</p><input id="dv-pin" type="password" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="off" placeholder="••••••" required><div style="display:flex;gap:8px"><button type="button" class="dv-btn" id="dv-cancel-pin" style="flex:1">Hủy</button><button type="submit" class="dv-btn dv-primary" style="flex:1">Mở khóa</button></div><p id="dv-pin-error" style="color:#fda4af"></p></form></div>
    </section>`;
  document.body.appendChild(overlay);

  const $ = (id) => document.getElementById(id);
  let driveToken = sessionStorage.getItem("cong-viec-drive-admin-token") || "";
  let folderId = "root", folderStack = [], trashMode = false, searchTimer = null, busy = false;

  function status(text, error) {
    $("dv-status").textContent = text;
    $("dv-status").style.color = error ? "#fda4af" : "#a5b4fc";
  }
  async function api(path, options = {}) {
    const response = await fetch(API + path, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: "Bearer " + driveToken },
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Yêu cầu thất bại.");
    return data;
  }
  function openPanel() {
    overlay.style.display = "flex";
    if (!driveToken) {
      $("drive-pin-box").style.display = "flex";
      $("dv-pin").value = "";
      $("dv-pin-error").textContent = "";
      setTimeout(() => $("dv-pin").focus(), 20);
    } else {
      $("drive-pin-box").style.display = "none";
      refreshStatus();
    }
  }
  function closePanel() { overlay.style.display = "none"; }
  openButton.addEventListener("click", openPanel);
  $("dv-close").addEventListener("click", closePanel);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closePanel(); });
  $("dv-cancel-pin").addEventListener("click", closePanel);

  $("dv-pin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = $("dv-pin").value;
    if (!/^\d{6}$/.test(pin)) { $("dv-pin-error").textContent = "PIN phải gồm 6 chữ số."; return; }
    $("dv-pin-error").textContent = "Đang xác minh...";
    try {
      const response = await fetch(API + "/api/drive/admin/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }), cache: "no-store"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.token) throw new Error(data.error || "PIN không đúng.");
      driveToken = data.token;
      sessionStorage.setItem("cong-viec-drive-admin-token", driveToken);
      $("drive-pin-box").style.display = "none";
      await refreshStatus();
    } catch (error) { $("dv-pin-error").textContent = error.message; }
  });

  async function refreshStatus() {
    try {
      const data = await api("/api/drive/status");
      $("dv-account").textContent = data.connected ? "Đã kết nối: " + (data.email || "tài khoản Google") : "Chưa kết nối tài khoản Google";
      $("dv-connect").textContent = data.connected ? "Kết nối lại Google" : "Kết nối Google";
      if (data.connected) await loadFiles();
      else {
        status(data.configured ? "Kết nối Google để duyệt và quản lý Drive." : "Backend chưa đủ cấu hình OAuth. Xem hướng dẫn cấu hình bên dưới.", !data.configured);
        $("dv-list").replaceChildren();
        const info = document.createElement("div"); info.className = "dv-empty";
        info.textContent = data.configured ? "Bấm “Kết nối Google” để cấp quyền truy cập Drive." : "Cần cấu hình DRIVE_ADMIN_PIN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, FRONTEND_URL, GOOGLE_TOKEN_ENCRYPTION_KEY và SUPABASE_SERVICE_ROLE_KEY trên Render.";
        $("dv-list").appendChild(info);
      }
    } catch (error) { status(error.message, true); if (/session expired/i.test(error.message)) { driveToken = ""; sessionStorage.removeItem("cong-viec-drive-admin-token"); $("drive-pin-box").style.display = "flex"; } }
  }

  $("dv-connect").addEventListener("click", async () => {
    try {
      status("Đang mở trang xác nhận của Google...");
      const data = await api("/api/drive/oauth/start", { method: "POST" });
      if (!data.url) throw new Error("Không nhận được liên kết OAuth.");
      window.location.assign(data.url);
    } catch (error) { status(error.message, true); }
  });

  function formatSize(value) {
    const n = Number(value || 0);
    if (!n) return "—";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }
  function iconFor(file) {
    if (file.mimeType === "application/vnd.google-apps.folder") return "📁";
    if ((file.mimeType || "").startsWith("image/")) return "🖼️";
    if ((file.mimeType || "").startsWith("video/")) return "🎬";
    if ((file.mimeType || "").includes("pdf")) return "📄";
    return "📎";
  }
  async function loadFiles() {
    if (busy) return;
    busy = true;
    status("Đang tải danh sách file...");
    $("dv-list").replaceChildren();
    try {
      const q = $("dv-search").value.trim();
      const params = new URLSearchParams({ folderId, mode: trashMode ? "trash" : "files" });
      if (q) params.set("q", q);
      const data = await api("/api/drive/files?" + params);
      if (!data.files.length) {
        const empty = document.createElement("div"); empty.className = "dv-empty";
        empty.textContent = trashMode ? "Thùng rác đang trống." : "Không có file trong thư mục này.";
        $("dv-list").appendChild(empty);
      }
      data.files.forEach(file => renderFile(file));
      status(data.files.length + " mục hiển thị" + (data.nextPageToken ? " · còn nhiều mục khác" : ""));
    } catch (error) { status(error.message, true); }
    finally { busy = false; }
  }
  function actionButton(label, handler, danger) {
    const button = document.createElement("button");
    button.className = "dv-btn";
    button.textContent = label;
    if (danger) button.style.color = "#fda4af";
    button.addEventListener("click", handler);
    return button;
  }
  function renderFile(file) {
    const row = document.createElement("div"); row.className = "dv-row";
    const icon = document.createElement("div"); icon.className = "dv-icon"; icon.textContent = iconFor(file);
    const details = document.createElement("div"); details.className = "dv-file";
    const name = document.createElement("div"); name.className = "dv-name"; name.textContent = file.name;
    const meta = document.createElement("div"); meta.className = "dv-sub";
    meta.textContent = (file.mimeType === "application/vnd.google-apps.folder" ? "Thư mục" : formatSize(file.size)) + (file.modifiedTime ? " · sửa " + new Date(file.modifiedTime).toLocaleDateString("vi-VN") : "");
    details.append(name, meta);
    const actions = document.createElement("div"); actions.className = "dv-actions";
    if (!trashMode && file.mimeType === "application/vnd.google-apps.folder") {
      actions.appendChild(actionButton("Mở", () => { folderStack.push({ id: folderId, name: "Thư mục trước" }); folderId = file.id; $("dv-search").value = ""; loadFiles(); }));
    } else if (!trashMode && file.webViewLink) {
      const link = document.createElement("a"); link.className = "dv-btn"; link.href = file.webViewLink; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Mở";
      link.style.textDecoration = "none"; actions.appendChild(link);
    }
    if (trashMode) {
      actions.appendChild(actionButton("Khôi phục", async () => mutateFile(file.id, { trashed: false }, "Đã khôi phục file.")));
    } else {
      actions.appendChild(actionButton("Đổi tên", async () => {
        const next = window.prompt("Tên mới:", file.name);
        if (next && next.trim() && next.trim() !== file.name) await mutateFile(file.id, { name: next.trim() }, "Đã đổi tên.");
      }));
      actions.appendChild(actionButton("Di chuyển", async () => {
        const next = window.prompt("Nhập ID thư mục đích (để trống nếu muốn chuyển về Drive gốc):", "");
        if (next !== null) await mutateFile(file.id, { parentId: next.trim() || "root" }, "Đã di chuyển file.");
      }));
      actions.appendChild(actionButton("Thùng rác", async () => {
        if (window.confirm("Chuyển “" + file.name + "” vào thùng rác?")) await mutateFile(file.id, { trashed: true }, "Đã chuyển vào thùng rác.");
      }, true));
    }
    row.append(icon, details, actions); $("dv-list").appendChild(row);
  }
  async function mutateFile(id, patch, success) {
    try {
      await api("/api/drive/files/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      status(success); await loadFiles();
    } catch (error) { status(error.message, true); }
  }
  $("dv-folder").addEventListener("click", async () => {
    const name = window.prompt("Tên thư mục mới:");
    if (!name || !name.trim()) return;
    try { await api("/api/drive/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), parentId: folderId }) }); status("Đã tạo thư mục."); await loadFiles(); }
    catch (error) { status(error.message, true); }
  });
  $("dv-upload").addEventListener("click", () => $("dv-file-input").click());
  $("dv-file-input").addEventListener("change", async () => {
    const file = $("dv-file-input").files[0]; if (!file) return;
    if (file.size > 25 * 1024 * 1024) { status("File vượt quá giới hạn 25 MB.", true); $("dv-file-input").value = ""; return; }
    status("Đang tải lên " + file.name + "...");
    try {
      const params = new URLSearchParams({ name: file.name, parentId: folderId });
      await api("/api/drive/upload?" + params, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      status("Đã tải lên " + file.name); await loadFiles();
    } catch (error) { status(error.message, true); }
    finally { $("dv-file-input").value = ""; }
  });
  $("dv-trash-mode").addEventListener("click", () => {
    trashMode = !trashMode;
    $("dv-trash-mode").textContent = trashMode ? "Quay lại file" : "Thùng rác";
    $("dv-folder").style.display = trashMode ? "none" : "";
    $("dv-upload").style.display = trashMode ? "none" : "";
    folderId = "root"; loadFiles();
  });
  $("dv-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadFiles, 350); });

  const params = new URLSearchParams(location.search);
  if (params.has("drive")) {
    const result = params.get("drive");
    history.replaceState({}, "", location.pathname);
    if (result === "connected") setTimeout(() => { openPanel(); }, 350);
    else if (result === "error") setTimeout(() => { openPanel(); status("Google OAuth chưa hoàn tất. Kiểm tra redirect URI và cấu hình Google Cloud.", true); }, 350);
  }
})();
