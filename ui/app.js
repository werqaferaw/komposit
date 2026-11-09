// Komposit UI. One file, two homes:
//   local   served by the Komposit app at http://127.0.0.1:<port>/ (the token
//           is inlined in the page by the app)
//   hosted  served from the web; talks straight to the app on this computer. The
//           token arrives once in the URL fragment from the app's /connect.
"use strict";

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k) { try { return localStorage.getItem("komposit." + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("komposit." + k, String(v)); } catch {} },
  del(k) { try { localStorage.removeItem("komposit." + k); } catch {} },
};

// Elapsed time, rolling up units ("1m 05s", not "65.0s").
function fmtDur(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + String(Math.floor(s % 60)).padStart(2, "0") + "s";
  const h = Math.floor(m / 60);
  return h + "h " + String(m % 60).padStart(2, "0") + "m";
}

// Minimal, XSS-safe markdown (escape first, then format the escaped text).
function md(src) {
  const lines = String(src || "").replace(/\r/g, "").split("\n");
  let html = "", inList = null, inCode = false, code = "";
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  const closeList = () => { if (inList) { html += `</${inList}>`; inList = null; } };
  let quote = null; // lines of a "> " block, rendered as one blockquote
  const closeQuote = () => { if (quote) { html += `<blockquote>${md(quote.join("\n"))}</blockquote>`; quote = null; } };
  for (const line of lines) {
    const q = !inCode && line.match(/^\s*>\s?(.*)$/);
    if (q) { closeList(); (quote = quote || []).push(q[1]); continue; }
    closeQuote();
    if (/^```/.test(line)) { if (inCode) { html += `<pre><code>${esc(code)}</code></pre>`; code = ""; inCode = false; } else { closeList(); inCode = true; } continue; }
    if (inCode) { code += line + "\n"; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) { closeList(); html += `<h4>${inline(h[2])}</h4>`; }
    else if (ul) { if (inList !== "ul") { closeList(); html += "<ul>"; inList = "ul"; } html += `<li>${inline(ul[1])}</li>`; }
    else if (ol) { if (inList !== "ol") { closeList(); html += "<ol>"; inList = "ol"; } html += `<li>${inline(ol[1])}</li>`; }
    else if (line.trim() === "") closeList();
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeQuote(); closeList(); if (inCode) html += `<pre><code>${esc(code)}</code></pre>`;
  return html;
}

/* ---------------- icons ---------------- */
// Hugeicons free set (stroke rounded, MIT), copied as paths so the page has
// no icon dependency. Source: @hugeicons/core-free-icons 4.4.0.
const P = {
  sidebar: '<path d="M2 12C2 8.31087 2 6.4663 2.81382 5.15877C3.1149 4.67502 3.48891 4.25427 3.91891 3.91554C5.08116 3 6.72077 3 10 3H14C17.2792 3 18.9188 3 20.0811 3.91554C20.5111 4.25427 20.8851 4.67502 21.1862 5.15877C22 6.4663 22 8.31087 22 12C22 15.6891 22 17.5337 21.1862 18.8412C20.8851 19.325 20.5111 19.7457 20.0811 20.0845C18.9188 21 17.2792 21 14 21H10C6.72077 21 5.08116 21 3.91891 20.0845C3.48891 19.7457 3.1149 19.325 2.81382 18.8412C2 17.5337 2 15.6891 2 12Z"/><path d="M9.5 3L9.5 21"/><path d="M5 7H6M5 10H6"/>',
  edit: '<path d="M16.4249 4.60509L17.4149 3.6151C18.2351 2.79497 19.5648 2.79497 20.3849 3.6151C21.205 4.43524 21.205 5.76493 20.3849 6.58507L19.3949 7.57506M16.4249 4.60509L9.76558 11.2644C9.25807 11.772 8.89804 12.4078 8.72397 13.1041L8 16L10.8959 15.276C11.5922 15.102 12.228 14.7419 12.7356 14.2344L19.3949 7.57506M16.4249 4.60509L19.3949 7.57506"/><path d="M18.9999 13.5C18.9999 16.7875 18.9999 18.4312 18.092 19.5376C17.9258 19.7401 17.7401 19.9258 17.5375 20.092C16.4312 21 14.7874 21 11.4999 21H11C7.22876 21 5.34316 21 4.17159 19.8284C3.00003 18.6569 3 16.7712 3 13V12.5C3 9.21252 3 7.56879 3.90794 6.46244C4.07417 6.2599 4.2599 6.07417 4.46244 5.90794C5.56879 5 7.21252 5 10.5 5"/>',
  send: '<path d="M12 5.5V19"/><path d="M18 11C18 11 13.5811 5.00001 12 5C10.4188 4.99999 6 11 6 11"/>',
  stop: '<path fill="currentColor" d="M4 12C4 8.72077 4 7.08116 4.81382 5.91891C5.1149 5.48891 5.48891 5.1149 5.91891 4.81382C7.08116 4 8.72077 4 12 4C15.2792 4 16.9188 4 18.0811 4.81382C18.5111 5.1149 18.8851 5.48891 19.1862 5.91891C20 7.08116 20 8.72077 20 12C20 15.2792 20 16.9188 19.1862 18.0811C18.8851 18.5111 18.5111 18.8851 18.0811 19.1862C16.9188 20 15.2792 20 12 20C8.72077 20 7.08116 20 5.91891 19.1862C5.48891 18.8851 5.1149 18.5111 4.81382 18.0811C4 16.9188 4 15.2792 4 12Z"/>',
  close: '<path d="M18.9991 19L5 5.00098"/><path d="M19 5L5.00092 18.999"/>',
  chev: '<path d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9"/>',
  plus: '<path d="M12.001 4.00101V20.001"/><path d="M20.001 12.001L4.00098 12.001"/>',
  folder: '<path d="M13.6656 6.49446H16C18.8284 6.49446 20.2426 6.49446 21.1213 7.37314C22 8.25182 22 9.66603 22 12.4945V14.5C22 17.3284 22 18.7426 21.1213 19.6213C20.2426 20.5 18.8284 20.5 16 20.5H8C5.17157 20.5 3.75736 20.5 2.87868 19.6213C2 18.7426 2 17.3284 2 14.5V8.99183C2 6.65409 2 5.48521 2.61604 4.67881C2.7778 4.46706 2.96706 4.2778 3.17881 4.11604C3.98521 3.5 5.15409 3.5 7.49183 3.5C8.16633 3.5 8.50358 3.5 8.81392 3.60442C8.8976 3.63257 8.97932 3.66623 9.05854 3.70518C9.35239 3.84965 9.59179 4.08719 10.0706 4.56227L10.8483 5.33389C11.4254 5.9066 11.714 6.19295 12.08 6.3437C12.446 6.49446 12.8525 6.49446 13.6656 6.49446Z"/>',
  back: '<path d="M15 6C15 6 9.00001 10.4189 9 12C8.99999 13.5812 15 18 15 18"/>',
  image: '<circle cx="7.5" cy="7.5" r="1.5"/><path d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z"/><path d="M5 21C9.37246 15.775 14.2741 8.88406 21.4975 13.5424"/>',
  settings: '<path d="M3.95631 10.5829L3.03254 9.07084C2.74505 8.60024 2.7389 8.00978 3.01652 7.5333L3.63533 6.47124C3.90953 6.00064 4.41721 5.71571 4.96162 5.7269L6.69131 5.76245C6.92616 5.76728 7.15379 5.68727 7.34333 5.54846C7.79531 5.21745 8.28334 4.93276 8.80042 4.70139C9.01191 4.60675 9.19222 4.45165 9.30469 4.24903L10.1203 2.77965C10.3847 2.30328 10.8865 2.00781 11.4312 2.00781H12.6937C13.2384 2.00781 13.7403 2.30329 14.0047 2.77966L14.8202 4.24902C14.9327 4.45165 15.113 4.60675 15.3245 4.70139C15.8416 4.93274 16.3296 5.2174 16.7815 5.54838C16.9711 5.68718 17.1987 5.76718 17.4336 5.76235L19.1634 5.72676C19.7078 5.71557 20.2155 6.00049 20.4897 6.47111L21.1085 7.53314C21.3862 8.00963 21.38 8.60009 21.0925 9.07068L20.1687 10.5828C20.0481 10.7803 20.002 11.0134 20.0235 11.2439C20.0707 11.7486 20.0707 12.267 20.0235 12.7717C20.002 13.0022 20.0481 13.2353 20.1687 13.4329L21.0924 14.9448C21.3799 15.4154 21.3861 16.0058 21.1084 16.4823L20.4896 17.5444C20.2154 18.015 19.7077 18.2999 19.1633 18.2887L17.4338 18.2531C17.1989 18.2483 16.9713 18.3283 16.7817 18.4671C16.3297 18.7982 15.8416 19.0829 15.3245 19.3142C15.113 19.4089 14.9327 19.564 14.8202 19.7666L14.0047 21.236C13.7403 21.7123 13.2384 22.0078 12.6937 22.0078H11.4312C10.8866 22.0078 10.3847 21.7123 10.1203 21.236L9.30468 19.7665C9.19222 19.5639 9.01191 19.4088 8.80042 19.3142C8.28329 19.0828 7.79519 18.798 7.34316 18.467C7.15362 18.3282 6.92597 18.2482 6.69111 18.253L4.96175 18.2886C4.41733 18.2998 3.90963 18.0148 3.63543 17.5442L3.01663 16.4822C2.739 16.0057 2.74515 15.4152 3.03264 14.9446L3.95631 13.4327C4.07699 13.2351 4.12309 13.002 4.10154 12.7715C4.05437 12.267 4.05438 11.7486 4.10154 11.244C4.12308 11.0135 4.07699 10.7805 3.95631 10.5829Z"/><circle cx="12.0625" cy="12.0078" r="3.5"/>',
  check: '<path d="M5 14L8.5 17.5L19 6.5"/>',
  checkCircle: '<path d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z"/><path d="M8 12.5L10.5 15L16 9"/>',
  x: '<path d="M18.9991 19L5 5.00098"/><path d="M19 5L5.00092 18.999"/>',
  xCircle: '<path d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z"/><path d="M14.9994 15L12 12.0003M12 12.0003L9 9M12 12.0003L9.00064 15M12 12.0003L15 9"/>',
  alert: '<path d="M13.9248 21H10.0752C5.44476 21 3.12955 21 2.27636 19.4939C1.42317 17.9879 2.60736 15.9914 4.97574 11.9985L6.90057 8.75333C9.17559 4.91778 10.3131 3 12 3C13.6869 3 14.8244 4.91777 17.0994 8.75332L19.0243 11.9985C21.3926 15.9914 22.5768 17.9879 21.7236 19.4939C20.8704 21 18.5552 21 13.9248 21Z"/><path d="M12 9V13"/><path d="M12.125 16.75H12M12.25 16.75C12.25 16.8881 12.1381 17 12 17C11.8619 17 11.75 16.8881 11.75 16.75C11.75 16.6119 11.8619 16.5 12 16.5C12.1381 16.5 12.25 16.6119 12.25 16.75Z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 8V12L14 14"/>',
  external: '<path d="M11.0991 3.00012C7.45013 3.00669 5.53932 3.09629 4.31817 4.31764C3.00034 5.63568 3.00034 7.75704 3.00034 11.9997C3.00034 16.2424 3.00034 18.3638 4.31817 19.6818C5.63599 20.9999 7.75701 20.9999 11.9991 20.9999C16.241 20.9999 18.3621 20.9999 19.6799 19.6818C20.901 18.4605 20.9906 16.5493 20.9972 12.8998"/><path d="M20.556 3.49612L11.0487 13.0586M20.556 3.49612C20.062 3.00151 16.7343 3.04761 16.0308 3.05762M20.556 3.49612C21.05 3.99074 21.0039 7.32273 20.9939 8.02714"/>',
  copy: '<path d="M7.5 14.5C7.5 11.2002 7.5 9.55025 8.52513 8.52513C9.55025 7.5 11.2002 7.5 14.5 7.5C17.7998 7.5 19.4497 7.5 20.4749 8.52513C21.5 9.55025 21.5 11.2002 21.5 14.5C21.5 17.7998 21.5 19.4497 20.4749 20.4749C19.4497 21.5 17.7998 21.5 14.5 21.5C11.2002 21.5 9.55025 21.5 8.52513 20.4749C7.5 19.4497 7.5 17.7998 7.5 14.5Z"/><path d="M7.5 16.5C6.10355 16.5 5.40533 16.5 4.84402 16.3036C3.83866 15.9518 3.0482 15.1613 2.69641 14.156C2.5 13.5947 2.5 12.8964 2.5 11.5V9.5C2.5 6.20017 2.5 4.55025 3.52513 3.52513C4.55025 2.5 6.20017 2.5 9.5 2.5H11.5C12.8964 2.5 13.5947 2.5 14.156 2.69641C15.1613 3.0482 15.9518 3.83866 16.3036 4.84402C16.5 5.40533 16.5 6.10355 16.5 7.5"/>',
  refresh: '<path d="M20.4879 15C19.2524 18.4956 15.9187 21 12 21C7.02943 21 3 16.9706 3 12C3 7.02943 7.02943 3 12 3C15.7292 3 18.9286 5.26806 20.2941 8.5"/><path d="M15 9H18C19.4142 9 20.1213 9 20.5607 8.56066C21 8.12132 21 7.41421 21 6V3"/>',
  dot: '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>',
  clip: '<path d="M9.5 8V14.5C9.5 15.8807 10.6193 17 12 17C13.3807 17 14.5 15.8807 14.5 14.5V6.5C14.5 4.01472 12.4853 2 10 2C7.51472 2 5.5 4.01472 5.5 6.5V15.5C5.5 19.0899 8.41015 22 12 22C15.5899 22 18.5 19.0899 18.5 15.5V6"/>',
  file: '<path d="M8 7L16 7"/><path d="M8 11L12 11"/><path d="M13 21.5V21C13 18.1716 13 16.7574 13.8787 15.8787C14.7574 15 16.1716 15 19 15H19.5M20 13.3431V10C20 6.22876 20 4.34315 18.8284 3.17157C17.6569 2 15.7712 2 12 2C8.22877 2 6.34315 2 5.17157 3.17157C4 4.34314 4 6.22876 4 10L4 14.5442C4 17.7892 4 19.4117 4.88607 20.5107C5.06508 20.7327 5.26731 20.9349 5.48933 21.1139C6.58831 22 8.21082 22 11.4558 22C12.1614 22 12.5141 22 12.8372 21.886C12.9044 21.8623 12.9702 21.835 13.0345 21.8043C13.3436 21.6564 13.593 21.407 14.0919 20.9081L18.8284 16.1716C19.4065 15.5935 19.6955 15.3045 19.8478 14.9369C20 14.5694 20 14.1606 20 13.3431Z"/>',
  mic: '<path d="M7 6.5C7 4.01472 9.01472 2 11.5 2C13.9853 2 16 4.01472 16 6.5V11.5C16 13.9853 13.9853 16 11.5 16C9.01472 16 7 13.9853 7 11.5V6.5Z"/><path d="M11.5 19H11.0828C7.57267 19 4.57706 16.4623 4 13M11.5 19H11.9172C15.4273 19 18.4229 16.4623 19 13M11.5 19V22"/>',
  lock: '<path d="M12 14.5V17.5M13 14.5C13 15.0523 12.5523 15.5 12 15.5C11.4477 15.5 11 15.0523 11 14.5C11 13.9477 11.4477 13.5 12 13.5C12.5523 13.5 13 13.9477 13 14.5Z"/><path d="M16.5 9V6.5C16.5 4.01472 14.4853 2 12 2C9.51471 2 7.49999 4.01472 7.49999 6.5V9"/><path d="M4.2678 18.8447C4.49268 20.515 5.87612 21.8235 7.55965 21.9009C8.97627 21.966 10.4153 22 12 22C13.5847 22 15.0237 21.966 16.4403 21.9009C18.1239 21.8235 19.5073 20.515 19.7322 18.8447C19.8789 17.7547 20 16.6376 20 15.5C20 14.3624 19.8789 13.2453 19.7322 12.1553C19.5073 10.485 18.1239 9.17649 16.4403 9.09909C15.0237 9.03397 13.5847 9 12 9C10.4153 9 8.97627 9.03397 7.55965 9.09909C5.87612 9.17649 4.49268 10.485 4.2678 12.1553C4.12104 13.2453 3.99999 14.3624 3.99999 15.5C3.99999 16.6376 4.12104 17.7547 4.2678 18.8447Z"/>',
  download: '<path d="M2.99969 17.0002C2.99969 17.9302 2.99969 18.3952 3.10192 18.7767C3.37932 19.8119 4.18796 20.6206 5.22324 20.898C5.60474 21.0002 6.06972 21.0002 6.99969 21.0002L16.9997 21.0002C17.9297 21.0002 18.3947 21.0002 18.7762 20.898C19.8114 20.6206 20.6201 19.8119 20.8975 18.7767C20.9997 18.3952 20.9997 17.9302 20.9997 17.0002"/><path d="M16.4998 11.5002C16.4998 11.5002 13.1856 16.0002 11.9997 16.0002C10.8139 16.0002 7.49976 11.5002 7.49976 11.5002M11.9997 15.0002V3.00016"/>',
  stopped: '<circle cx="12" cy="12" r="10"/><path d="M9.38886 15.1629C9.89331 15.5 10.5955 15.5 12 15.5C13.4045 15.5 14.1067 15.5 14.6111 15.1629C14.8295 15.017 15.017 14.8295 15.1629 14.6111C15.5 14.1067 15.5 13.4045 15.5 12C15.5 10.5955 15.5 9.89331 15.1629 9.38886C15.017 9.17048 14.8295 8.98298 14.6111 8.83706C14.1067 8.5 13.4045 8.5 12 8.5C10.5955 8.5 9.89331 8.5 9.38886 8.83706C9.17048 8.98298 8.98298 9.17048 8.83706 9.38886C8.5 9.89331 8.5 10.5955 8.5 12C8.5 13.4045 8.5 14.1067 8.83706 14.6111C8.98298 14.8295 9.17048 15.017 9.38886 15.1629Z"/>',
};
const svg = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ""}</svg>`;
// Monochrome app marks (Simple Icons 9.21, CC0): a filled tile with the
// letters knocked out, coloured by currentColor.
const APPMARK = {
  illustrator: 'M10.53 10.73c-.1-.31-.19-.61-.29-.92-.1-.31-.19-.6-.27-.89-.08-.28-.15-.54-.22-.78h-.02c-.09.43-.2.86-.34 1.29-.15.48-.3.98-.46 1.48-.14.51-.29.98-.44 1.4h2.54c-.06-.211-.14-.46-.23-.721-.09-.269-.18-.559-.27-.859zM19.75.3H4.25C1.9.3 0 2.2 0 4.55v14.9c0 2.35 1.9 4.25 4.25 4.25h15.5c2.35 0 4.25-1.9 4.25-4.25V4.55C24 2.2 22.1.3 19.75.3zM14.7 16.83h-2.091c-.069.01-.139-.04-.159-.11l-.82-2.38H7.91l-.76 2.35c-.02.09-.1.15-.19.141H5.08c-.11 0-.14-.061-.11-.18L8.19 7.38c.03-.1.06-.21.1-.33.04-.21.06-.43.06-.65-.01-.05.03-.1.08-.11h2.59c.08 0 .12.03.13.08l3.65 10.3c.03.109 0 .16-.1.16zm3.4-.15c0 .11-.039.16-.129.16H16.01c-.1 0-.15-.061-.15-.16v-7.7c0-.1.041-.14.131-.14h1.98c.09 0 .129.05.129.14v7.7zm-.209-9.03c-.231.24-.571.37-.911.35-.33.01-.65-.12-.891-.35-.23-.25-.35-.58-.34-.92-.01-.34.12-.66.359-.89.242-.23.562-.35.892-.35.391 0 .689.12.91.35.22.24.34.56.33.89.01.34-.11.67-.349.92z',
  photoshop: 'M9.85 8.42c-.37-.15-.77-.21-1.18-.2-.26 0-.49 0-.68.01-.2-.01-.34 0-.41.01v3.36c.14.01.27.02.39.02h.53c.39 0 .78-.06 1.15-.18.32-.09.6-.28.82-.53.21-.25.31-.59.31-1.03.01-.31-.07-.62-.23-.89-.17-.26-.41-.46-.7-.57zM19.75.3H4.25C1.9.3 0 2.2 0 4.55v14.899c0 2.35 1.9 4.25 4.25 4.25h15.5c2.35 0 4.25-1.9 4.25-4.25V4.55C24 2.2 22.1.3 19.75.3zm-7.391 11.65c-.399.56-.959.98-1.609 1.22-.68.25-1.43.34-2.25.34-.24 0-.4 0-.5-.01s-.24-.01-.43-.01v3.209c.01.07-.04.131-.11.141H5.52c-.08 0-.12-.041-.12-.131V6.42c0-.07.03-.11.1-.11.17 0 .33 0 .56-.01.24-.01.49-.01.76-.02s.56-.01.87-.02c.31-.01.61-.01.91-.01.82 0 1.5.1 2.06.31.5.17.96.45 1.34.82.32.32.57.71.73 1.14.149.42.229.85.229 1.3.001.86-.199 1.57-.6 2.13zm7.091 3.89c-.28.4-.671.709-1.12.891-.49.209-1.09.318-1.811.318-.459 0-.91-.039-1.359-.129-.35-.061-.7-.17-1.02-.32-.07-.039-.121-.109-.111-.189v-1.74c0-.029.011-.07.041-.09.029-.02.06-.01.09.01.39.23.8.391 1.24.49.379.1.779.15 1.18.15.38 0 .65-.051.83-.141.16-.07.27-.24.27-.42 0-.141-.08-.27-.24-.4-.16-.129-.489-.279-.979-.471-.51-.18-.979-.42-1.42-.719-.31-.221-.569-.51-.761-.85-.159-.32-.239-.67-.229-1.021 0-.43.12-.84.341-1.21.25-.4.619-.72 1.049-.92.469-.239 1.059-.349 1.769-.349.41 0 .83.03 1.24.09.3.04.59.12.86.23.039.01.08.05.1.09.01.04.02.08.02.12v1.63c0 .04-.02.08-.05.1-.09.02-.14.02-.18 0-.3-.16-.62-.27-.96-.34-.37-.08-.74-.13-1.12-.13-.2-.01-.41.02-.601.07-.129.03-.24.1-.31.2-.05.08-.08.18-.08.27s.04.18.101.26c.09.11.209.2.34.27.229.12.47.23.709.33.541.18 1.061.43 1.541.73.33.209.6.49.789.83.16.318.24.67.23 1.029.011.471-.129.94-.389 1.331z',
  aftereffects: 'M8.54 10.73c-.1-.31-.19-.61-.29-.92s-.19-.6-.27-.89c-.08-.28-.15-.54-.22-.78h-.02c-.09.43-.2.86-.34 1.29-.15.48-.3.98-.46 1.48-.13.51-.29.98-.44 1.4h2.54c-.06-.21-.14-.46-.23-.72-.09-.27-.18-.56-.27-.86zm8.58-.29c-.55-.03-1.07.26-1.33.76-.12.23-.19.47-.22.72h2.109c.26 0 .45 0 .57-.01.08-.01.16-.03.23-.08v-.1c0-.13-.021-.25-.061-.37-.178-.56-.708-.94-1.298-.92zM19.75.3H4.25C1.9.3 0 2.2 0 4.55v14.9c0 2.35 1.9 4.25 4.25 4.25h15.5c2.35 0 4.25-1.9 4.25-4.25V4.55C24 2.2 22.1.3 19.75.3zm-7.04 16.511h-2.09c-.07.01-.14-.041-.16-.11l-.82-2.4H5.92l-.76 2.36c-.02.09-.1.15-.19.14H3.09c-.11 0-.14-.06-.11-.18L6.2 7.39c.03-.1.06-.19.1-.31.04-.21.06-.43.06-.65-.01-.05.03-.1.08-.11h2.59c.07 0 .12.03.13.08l3.65 10.25c.03.11.001.161-.1.161zm7.851-3.991c-.021.189-.031.33-.041.42-.01.07-.069.13-.14.13-.06 0-.17.01-.33.021-.159.02-.35.029-.579.029-.23 0-.471-.04-.73-.04h-3.17c.039.31.14.62.31.89.181.271.431.48.729.601.4.17.841.26 1.281.25.35-.011.699-.04 1.039-.11.311-.039.61-.119.891-.23.05-.039.08-.02.08.08v1.531c0 .039-.01.08-.021.119-.021.03-.04.051-.069.07-.32.14-.65.24-1 .3-.471.09-.94.13-1.42.12-.761 0-1.4-.12-1.92-.35-.49-.211-.921-.541-1.261-.95-.319-.39-.55-.83-.69-1.31-.14-.471-.209-.961-.209-1.461 0-.539.08-1.07.25-1.59.16-.5.41-.96.75-1.37.33-.4.739-.72 1.209-.95.471-.23 1.03-.31 1.67-.31.531-.01 1.06.09 1.55.31.41.18.77.45 1.05.8.26.34.47.72.601 1.14.129.4.189.81.189 1.22 0 .24-.01.45-.019.64z',
};
const appMark = (id) => APPMARK[id] ? `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${APPMARK[id]}"/></svg>` : "";
const ic = (n) => `<span class="ic">${svg(n)}</span>`;
function paintIcons(root = document) { $$("[data-icon]", root).forEach((n) => { n.innerHTML = svg(n.dataset.icon); }); }

const CODE = { illustrator: "Ai", photoshop: "Ps", aftereffects: "Ae" };
const APPNAME = { illustrator: "Illustrator", photoshop: "Photoshop", aftereffects: "After Effects" };
const EFFORT = { low: "Fast", medium: "Balanced", high: "Thorough" };
const EFFORTS = ["low", "medium", "high"];

/* ---------------- platform words ----------------
   The same page serves the Mac app and the Windows app. Before it connects it
   goes by the browser; once connected, the app says which one it is. */
function guessOS() {
  const p = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""} ${navigator.userAgent || ""}`;
  return /Win/i.test(p) ? "win" : "mac";
}
let OS = guessOS();
const WORDS = {
  mac: {
    device: "Mac",
    tray: "menu bar",
    openApp: "Open Komposit from your Applications folder. Its icon appears in the menu bar, and this page connects as soon as it starts.",
    installClaude: "curl -fsSL https://claude.ai/install.sh | bash",
    shell: "Terminal",
    connectLead: "macOS asks once per app before Komposit may control it. Open the apps you use and allow each one. You can do this later from Settings.",
    askOnce: "macOS will ask you to allow this once",
    answerPrompt: "Answer the macOS prompt",
    answerPrompts: "Answer the macOS prompts",
    aeScriptFiles: "Turn on Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network in After Effects",
  },
  win: {
    device: "PC",
    tray: "system tray",
    openApp: "Open Komposit from the Start menu. Its icon appears in the system tray, next to the clock, and this page connects as soon as it starts.",
    installClaude: "irm https://claude.ai/install.ps1 | iex",
    shell: "PowerShell",
    connectLead: "Komposit connects to your Adobe apps directly; Windows doesn't ask for permission. Open the apps you use and test each connection. You can do this later from Settings.",
    askOnce: "Ready to test",
    answerPrompt: "Testing",
    answerPrompts: "Checking",
    aeScriptFiles: "Turn on Edit > Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network in After Effects",
  },
};
const w = (k) => WORDS[OS][k];

/* ---------------- connection ---------------- */
const K = { mode: "local", base: "", token: "", port: null };
const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content || "";
const DOWNLOADS = {
  mac: meta("komposit-download") || "https://komposit.werq.dev",
  win: meta("komposit-download-win") || meta("komposit-download") || "https://komposit.werq.dev",
};
const downloadURL = () => DOWNLOADS[OS];
const downloadLabel = () => (OS === "win" ? "Download for Windows" : "Download for Mac");
const PORTS = Array.from({ length: 10 }, (_, i) => 4321 + i);

class NotPaired extends Error {}

async function api(path, opts = {}) {
  const headers = { authorization: "Bearer " + K.token, ...(opts.headers || {}) };
  let body = opts.body;
  if (body !== undefined && typeof body !== "string") { body = JSON.stringify(body); headers["content-type"] = "application/json"; }
  const res = await fetch(K.base + path, { method: opts.method || "GET", headers, body, signal: opts.signal });
  if (res.status === 401) { if (K.mode === "hosted") gatePair(); throw new NotPaired("not paired"); }
  return res;
}
const getJSON = async (p) => (await api(p)).json();
const postJSON = async (p, body = {}) => (await api(p, { method: "POST", body })).json();

// Images from the app need the token, so they load as blobs.
const imgCache = new Map();
function authURL(path) {
  if (!imgCache.has(path)) {
    const p = (async () => {
      const r = await api(path);
      if (!r.ok) throw new Error("no image");
      return URL.createObjectURL(await r.blob());
    })();
    p.catch(() => imgCache.delete(path));
    imgCache.set(path, p);
  }
  return imgCache.get(path);
}
function setImg(img, path, onFail) {
  authURL(path).then((u) => { img.src = u; }).catch(() => { if (onFail) onFail(); });
}

function isChromium() {
  const brands = navigator.userAgentData?.brands || [];
  return brands.some((b) => /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/i.test(b.brand)) || /Chrome\/|Edg\//.test(navigator.userAgent);
}
function isWebKitOnly() {
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !isChromium() && !/Firefox\//.test(ua);
}

// Chrome asks once before a website may reach apps on this device.
async function lnaState() {
  for (const name of ["loopback-network", "local-network-access", "local-network"]) {
    try { return (await navigator.permissions.query({ name })).state; } catch {}
  }
  return "unknown";
}

async function hello(port, timeout) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(timeout) });
    const j = await r.json();
    return j && j.komposit ? port : null;
  } catch { return null; }
}

async function discover(first, timeout) {
  const hit = await hello(first, timeout);
  if (hit) return hit;
  const found = await Promise.all(PORTS.filter((p) => p !== first).map((p) => hello(p, 2500)));
  return found.find(Boolean) || null;
}

async function hostedConnect() {
  K.mode = "hosted";
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("k")) {
    store.set("token", h.get("k"));
    if (h.get("p")) store.set("port", h.get("p"));
    history.replaceState(null, "", location.pathname + location.search);
  }
  K.token = store.get("token") || "";
  const saved = Number(store.get("port")) || 4321;
  if (isWebKitOnly()) return gateSafari(saved);

  let perm = await lnaState();
  if (perm === "denied") return gateBlocked(saved);
  if (perm === "prompt") gatePermission();
  else gateMessage("Connecting to Komposit", `Looking for the Komposit app on this ${w("device")}.`);
  const port = await discover(saved, perm === "prompt" ? 120000 : 3000);
  if (!port) {
    perm = await lnaState();
    if (perm === "denied") return gateBlocked(saved);
    return gateNotRunning(saved);
  }
  K.port = port; K.base = `http://127.0.0.1:${port}`; store.set("port", port);
  if (!K.token) return gatePair();
  try { await getJSON("/api/status"); } catch (e) { if (e instanceof NotPaired) return; return gateNotRunning(port); }
  return connected();
}

/* ---------------- gate screens ---------------- */
function gate(html) {
  document.body.classList.add("gated");
  const g = $("#gate-in");
  g.innerHTML = `<div class="gate-brand">${$(".brand .logo")?.outerHTML || "Komposit"}</div>${html}`;
  paintIcons(g);
  return g;
}
function ungate() { document.body.classList.remove("gated"); $("#gate-in").innerHTML = ""; }

function gateMessage(title, text) {
  gate(`<h1>${esc(title)}</h1><p class="lead">${esc(text)}</p><div class="status-line"><span class="spinner"></span><span>Working</span></div>`);
}
function gatePermission() {
  gate(`<h1>Allow Komposit to connect</h1>
    <p class="lead">Your browser will ask whether this page may connect to apps on this device. Choose <b>Allow</b>. That lets this page reach the Komposit app on your ${w("device")}, and nothing else.</p>
    <div class="status-line"><span class="spinner"></span><span>Waiting for your answer</span></div>`);
}
function localCopyURL(port) { return `http://127.0.0.1:${port || 4321}/`; }
function gateSafari(port) {
  const g = gate(`<h1>Open Komposit</h1>
    <p class="lead">Safari doesn't let websites talk to apps on your Mac, so Komposit shows this page itself. Make sure Komposit is running (its icon is in the menu bar), then open it.</p>
    <div class="actions" style="justify-content:flex-start"><a class="btn primary" href="${localCopyURL(port)}">${ic("external")} Open Komposit</a>
    <a class="btn" href="${esc(DOWNLOADS.mac)}">${ic("download")} Download for Mac</a></div>
    <p class="gate-foot">Prefer working on the web? Chrome, Arc, Edge and Brave connect from this page directly.</p>`);
  return g;
}
function gateBlocked(port) {
  const g = gate(`<h1>Your browser is blocking the connection</h1>
    <p class="lead">This page was refused access to apps on this device. To allow it, click the site icon at the left of the address bar, open <b>Site settings</b>, set <b>Local network access</b> (or <b>Apps on this device</b>) to <b>Allow</b>, then reload.</p>
    <div class="actions" style="justify-content:flex-start"><button class="btn primary" id="g-reload">${ic("refresh")} Reload</button>
    <a class="btn" href="${localCopyURL(port)}">${ic("external")} Use Komposit's own page instead</a></div>`);
  $("#g-reload", g).onclick = () => location.reload();
}
function gateNotRunning(port) {
  const g = gate(`<h1>Komposit isn't running</h1>
    <p class="lead">${esc(w("openApp"))}</p>
    <div class="status-line"><span class="spinner"></span><span>Waiting for Komposit</span></div>
    <div class="actions" style="justify-content:flex-start;margin-top:18px"><a class="btn" href="${esc(downloadURL())}">${ic("download")} Don't have it yet? ${downloadLabel()}</a></div>`);
  (async () => {
    for (;;) {
      await sleep(3000);
      if (!$("#gate-in").contains(g.firstChild)) return;
      const p = await discover(port, 1500);
      if (p) { location.reload(); return; }
    }
  })();
}
function gatePair() {
  const ret = encodeURIComponent(location.origin);
  gate(`<h1>Connect this browser</h1>
    <p class="lead">Komposit is running on this ${w("device")}. Link this browser to it once; after that this page connects by itself.</p>
    <div class="actions" style="justify-content:flex-start"><a class="btn primary" href="${K.base}/connect?return=${ret}">${ic("lock")} Connect</a></div>
    <p class="gate-foot">This hands the page a private key that only the Komposit app on this ${w("device")} accepts.</p>`);
}

/* ---------------- state ---------------- */
const S = {
  status: null,
  apps: [],
  ctrl: { app: "illustrator", effort: store.get("effort") || "medium" },
  refs: [],
  chats: [],
  cur: null,
  running: null,
  appAutoSet: false,
};

/* ---------------- after connecting ---------------- */
async function connected() {
  try {
    S.status = await getJSON("/api/status");
    S.apps = (await getJSON("/api/apps")).apps || [];
  } catch (e) {
    if (e instanceof NotPaired) return;
    return K.mode === "hosted" ? gateNotRunning(K.port) : gateMessage("Komposit stopped", `The Komposit app isn't answering. Restart it from the ${w("tray")}.`);
  }
  // The app knows which system it runs on (older Mac builds don't say: Mac).
  if (S.status.platform) OS = S.status.platform === "win32" ? "win" : "mac";
  wireComposer($("#composer-start"));
  wireComposer($("#composer-dock"));
  renderEngine();
  if (!S.status.onboarded || !S.status.ai.mode) return onboarding(S.status.ai.mode ? 2 : 1);
  ungate();
  loadChats();
  loadWorkspace();
  const last = store.get("chat");
  if (last && location.hash === "#chat") openChat(last);
}

function renderEngine() {
  const ai = S.status?.ai || {};
  let title = "No AI chosen", sub = "Open settings";
  if (ai.mode === "claude-code") { title = "Claude subscription"; sub = "via Claude Code"; }
  else if (ai.mode === "codex") { title = "ChatGPT subscription"; sub = "via Codex"; }
  else if (ai.mode === "anthropic") { title = "Anthropic API"; sub = ai.anthropic?.model || "Claude Opus 5.5"; }
  else if (ai.mode === "openai") {
    let host = "";
    try { host = new URL(ai.openai.baseUrl).hostname; } catch {}
    title = /openrouter/.test(host) ? "OpenRouter" : host === "api.openai.com" ? "OpenAI" : host || "OpenAI-compatible";
    sub = ai.openai?.model || "";
  } else if (ai.mode === "invite") { title = "Invite"; sub = ai.invite?.name || "Komposit's key"; }
  $("#engine").innerHTML = `<b>${esc(title)}</b><span>${esc(sub)}</span>`;
}

/* ---------------- onboarding ---------------- */
function dots(n) { return `<div class="steps-dots">${[1, 2, 3].map((i) => `<span class="${i <= n ? "on" : ""}"></span>`).join("")}</div>`; }

async function onboarding(step) {
  if (step === 1) return obAI();
  if (step === 2) return obApps();
  return obFirst();
}

async function obAI() {
  const g = gate(`${dots(1)}<h1>How should Komposit think?</h1>
    <p class="lead">Komposit works with the AI you already have. Keys stay on this ${w("device")} and go only to the service you pick.</p>
    <div id="ob-ai"></div>`);
  const setup = await getJSON("/api/setup?fresh=1");
  aiChooser($("#ob-ai", g), setup, {
    saveLabel: "Continue",
    onSaved: async () => { S.status = await getJSON("/api/status"); renderEngine(); obApps(); },
  });
}

async function obApps() {
  const g = gate(`${dots(2)}<h1>Connect your Adobe apps</h1>
    <p class="lead">${esc(w("connectLead"))}</p>
    <div id="ob-apps"></div>
    <div class="actions"><button class="btn" id="ob-back">Back</button><span class="spacer"></span><button class="btn primary" id="ob-next">Continue</button></div>`);
  $("#ob-back", g).onclick = () => obAI();
  $("#ob-next", g).onclick = () => obFirst();
  appsPanel($("#ob-apps", g));
}

async function obFirst() {
  const setup = await getJSON("/api/setup").catch(() => ({ apps: [] }));
  const running = (setup.apps || []).filter((a) => a.running).map((a) => a.id);
  const ideas = [
    { app: "photoshop", text: "Add a soft vignette and set the main title in white" },
    { app: "illustrator", text: "Recolor the artwork to a navy and coral palette" },
    { app: "aftereffects", text: "Fade the title in over the first second" },
  ].sort((a, b) => running.includes(b.app) - running.includes(a.app));
  const g = gate(`${dots(3)}<h1>Try your first edit</h1>
    <p class="lead">Open a document in one of your apps, then ask for a change. Komposit works in the live file; everything it does stays in the app's undo history.</p>
    <div class="suggest">${ideas.map((i, n) => `<button data-n="${n}"><span class="code">${CODE[i.app]}</span>${esc(i.text)}</button>`).join("")}</div>
    <div class="actions"><button class="btn" id="ob-back">Back</button><span class="spacer"></span><button class="btn primary" id="ob-done">Open Komposit</button></div>`);
  const finish = async (idea) => {
    await postJSON("/api/setup/done", { done: true }).catch(() => {});
    S.status.onboarded = true;
    ungate(); loadChats(); await loadWorkspace();
    if (idea) { S.ctrl.app = idea.app; reflectAll(); const ta = $("#composer-start textarea"); ta.value = idea.text; ta.focus(); }
  };
  $$(".suggest button", g).forEach((b) => (b.onclick = () => finish(ideas[+b.dataset.n])));
  $("#ob-back", g).onclick = () => obApps();
  $("#ob-done", g).onclick = () => finish(null);
}

/* AI chooser (onboarding step 1 and Settings) */
function aiChooser(box, setup, { saveLabel = "Save", onSaved } = {}) {
  const ai = setup.ai || {};
  const cl = setup.claude || {};
  const cx = setup.codex || {};
  let pick = ai.mode || (cl.installed ? "claude-code" : "anthropic");
  const presets = setup.presets || {};
  const OPTIONS = [
    { id: "claude-code", t: "Claude subscription", d: `Your Claude Pro or Max plan, through Claude Code on this ${w("device")}. No API key.` },
    { id: "codex", t: "ChatGPT subscription (Codex)", d: `Your ChatGPT Plus or Pro plan, through Codex on this ${w("device")}. No API key.` },
    { id: "anthropic", t: "Anthropic API key", d: "Pay as you go with your own key. Runs Claude Opus 5.5." },
    { id: "openai", t: "OpenRouter or another OpenAI-compatible service", d: "Use a key from OpenRouter, OpenAI, or a compatible service." },
    { id: "invite", t: "Invite code", d: "Got a code from Komposit? Use it instead of your own AI account." },
  ];
  function body(id) {
    if (id === "claude-code") {
      let st;
      if (!cl.installed) st = `<div class="status-line bad">${ic("xCircle")}<span>Claude Code isn't installed on this ${w("device")}.</span></div>
        <div class="muted">Paste this into ${w("shell")}, then run <kbd>claude</kbd> once and sign in with your Claude account.</div>
        <div class="copyrow"><code>${esc(w("installClaude"))}</code><button class="btn small" data-copy="${esc(w("installClaude"))}">${ic("copy")} Copy</button></div>`;
      else if (cl.broken) st = `<div class="status-line bad">${ic("xCircle")}<span>Claude Code's install looks broken, usually from an update that didn't finish.</span></div>
        <div class="muted">Reinstall it by pasting this into ${w("shell")}, then check again.</div>
        <div class="copyrow"><code>${esc(cl.reinstall)}</code><button class="btn small" data-copy="${esc(cl.reinstall)}">${ic("copy")} Copy</button></div>`;
      else if (!cl.loggedIn) st = `<div class="status-line warn">${ic("alert")}<span>Claude Code is installed but not signed in.</span></div>
        <div class="muted">Open ${w("shell")}, run <kbd>claude</kbd>, and sign in with your Claude account. Then check again.</div>`;
      else st = `<div class="status-line ok">${ic("checkCircle")}<span>Claude Code is signed in${cl.subscriptionType ? ` (${esc(cap(cl.subscriptionType))} plan)` : ""}.</span></div>`;
      return st + (cl.loggedIn ? "" : `<div><button class="btn small" data-recheck>${ic("refresh")} Check again</button></div>`);
    }
    if (id === "codex") {
      const install = "npm install -g @openai/codex";
      let st;
      if (!cx.installed) st = `<div class="status-line bad">${ic("xCircle")}<span>Codex isn't installed on this ${w("device")}.</span></div>
        <div class="muted">Paste this into ${w("shell")} (it needs Node.js), then run <kbd>codex login</kbd> and sign in with your ChatGPT account.</div>
        <div class="copyrow"><code>${esc(install)}</code><button class="btn small" data-copy="${esc(install)}">${ic("copy")} Copy</button></div>`;
      else if (cx.broken) st = `<div class="status-line bad">${ic("xCircle")}<span>Codex's install looks broken.</span></div>
        <div class="muted">Reinstall it by pasting this into ${w("shell")}, then check again.</div>
        <div class="copyrow"><code>${esc(cx.reinstall)}</code><button class="btn small" data-copy="${esc(cx.reinstall)}">${ic("copy")} Copy</button></div>`;
      else if (!cx.loggedIn) st = `<div class="status-line warn">${ic("alert")}<span>Codex is installed but not signed in.</span></div>
        <div class="muted">Open ${w("shell")}, run <kbd>codex login</kbd>, and sign in with your ChatGPT account. Then check again.</div>`;
      else if (!cx.usesSubscription) st = `<div class="status-line warn">${ic("alert")}<span>Codex is signed in with an API key, not a ChatGPT plan.</span></div>
        <div class="muted">Open ${w("shell")}, run <kbd>codex login</kbd>, and choose Sign in with ChatGPT. Then check again.</div>`;
      else st = `<div class="status-line ok">${ic("checkCircle")}<span>Codex is signed in with ChatGPT.</span></div>`;
      return st + (cx.usesSubscription ? "" : `<div><button class="btn small" data-recheck-codex>${ic("refresh")} Check again</button></div>`);
    }
    if (id === "anthropic") {
      const saved = ai.anthropic?.hasKey ? `<div class="muted">Saved key: <kbd>${esc(ai.anthropic.keyHint)}</kbd>. Paste a new one to replace it.</div>` : "";
      return `<input class="field mono" type="password" id="f-akey" placeholder="sk-ant-..." autocomplete="off" spellcheck="false" />${saved}
        <div class="muted">Create a key at console.anthropic.com under API keys.</div>`;
    }
    if (id === "openai") {
      const cur = ai.openai || {};
      const pre = /openrouter/.test(cur.baseUrl || "openrouter") ? "openrouter" : cur.baseUrl === presets.openai?.baseUrl ? "openai" : "custom";
      return `<select class="field" id="f-oprov"><option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option><option value="custom">Other (custom address)</option></select>
        <input class="field mono" id="f-obase" placeholder="https://api.example.com/v1" value="${esc(cur.baseUrl || "")}" />
        <input class="field mono" type="password" id="f-okey" placeholder="${cur.hasKey ? "Saved key " + esc(cur.keyHint) + " (paste to replace)" : "API key"}" autocomplete="off" spellcheck="false" />
        <input class="field mono" id="f-omodel" placeholder="Model" value="${esc(cur.model || "")}" />
        <div class="muted">Pick a model that can see images: Komposit shows it renders of your document.</div>
        <span hidden id="f-opre">${pre}</span>`;
    }
    const saved = ai.invite?.hasCode ? `<div class="muted">Saved code: <kbd>${esc(ai.invite.codeHint)}</kbd>${ai.invite.name ? ` (${esc(ai.invite.name)})` : ""}.</div>` : "";
    return `<input class="field mono" id="f-invite" placeholder="kp_..." autocomplete="off" spellcheck="false" />${saved}
      <div class="muted">Invite codes have a daily limit. Your requests go through Komposit's server to Anthropic.</div>`;
  }
  function render() {
    box.innerHTML = `<div class="choices">${OPTIONS.map((o) => `<button class="choice ${o.id === pick ? "on" : ""}" data-id="${o.id}"><span class="radio"></span><span><div class="ct">${esc(o.t)}</div><div class="cd">${esc(o.d)}</div></span></button>${o.id === pick ? `<div class="choice-body">${body(o.id)}</div>` : ""}`).join("")}</div>
      <div class="err-text" id="f-err"></div>
      <div class="actions"><span class="spacer"></span><button class="btn primary" id="f-save">${esc(saveLabel)}</button></div>`;
    paintIcons(box);
    $$(".choice", box).forEach((c) => (c.onclick = () => { pick = c.dataset.id; render(); }));
    $$("[data-copy]", box).forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.innerHTML = ic("check") + " Copied"; } catch {} }));
    const rc = $("[data-recheck]", box);
    if (rc) rc.onclick = async () => { rc.disabled = true; const s = await getJSON("/api/setup?fresh=1"); Object.assign(cl, s.claude); render(); };
    const rcx = $("[data-recheck-codex]", box);
    if (rcx) rcx.onclick = async () => { rcx.disabled = true; const s = await getJSON("/api/setup?fresh=1"); Object.assign(cx, s.codex || {}); render(); };
    if (pick === "openai") {
      const sel = $("#f-oprov", box), base = $("#f-obase", box), model = $("#f-omodel", box);
      sel.value = $("#f-opre", box).textContent;
      const sync = (fill) => {
        const p = presets[sel.value];
        base.hidden = sel.value !== "custom";
        if (fill && p) { base.value = p.baseUrl; if (!model.value || Object.values(presets).some((x) => x.model === model.value)) model.value = p.model; }
      };
      sel.onchange = () => sync(true);
      sync(!ai.openai?.baseUrl);
    }
    $("#f-save", box).onclick = save;
  }
  async function save() {
    const btn = $("#f-save", box), err = $("#f-err", box);
    err.textContent = "";
    const payload = { mode: pick };
    if (pick === "anthropic") payload.apiKey = $("#f-akey", box).value.trim();
    if (pick === "openai") {
      const sel = $("#f-oprov", box).value;
      payload.baseUrl = sel === "custom" ? $("#f-obase", box).value.trim() : presets[sel]?.baseUrl;
      payload.apiKey = $("#f-okey", box).value.trim();
      payload.model = $("#f-omodel", box).value.trim();
    }
    if (pick === "invite") payload.code = $("#f-invite", box).value.trim();
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Checking`;
    try {
      const r = await postJSON("/api/setup/ai", payload);
      if (r.codex) Object.assign(cx, r.codex);
      if (!r.ok) { err.textContent = r.error || "That didn't work."; if (r.claude) Object.assign(cl, r.claude); return; }
      if (onSaved) await onSaved(r);
    } catch (e) { err.textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = saveLabel; }
  }
  render();
}
const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);

/* Apps + permissions panel (onboarding step 2 and Settings) */
async function appsPanel(box) {
  box.innerHTML = `<div class="status-line"><span class="spinner"></span><span>Checking your apps</span></div>`;
  let setup;
  try { setup = await getJSON("/api/setup"); } catch { box.innerHTML = `<div class="err-text">Couldn't read your apps.</div>`; return; }
  const row = (a) => {
    let right = "", sub = "";
    if (!a.installed) { sub = `Not installed on this ${w("device")}`; right = `<span class="pill">Not installed</span>`; }
    else if (!a.running) { sub = "Open it to connect"; right = `<button class="btn small" data-launch="${a.id}">Open</button>`; }
    else if (a.issue === "ae-dialog") { sub = "After Effects is showing a dialog. Close it there, then test again"; right = `<button class="btn small" data-allow="${a.id}">Test again</button>`; }
    else if (a.issue === "ae-script-files") { sub = w("aeScriptFiles"); right = `<button class="btn small" data-allow="${a.id}">Test again</button>`; }
    else if (a.automation === "allowed") { sub = "Komposit can work in it"; right = `<span class="pill ok">${ic("check")} Connected</span>`; }
    else if (a.automation === "denied") { sub = "Turned off in System Settings > Privacy & Security > Automation"; right = `<button class="btn small" data-pane="automation">Open System Settings</button>`; }
    else { sub = a.automation === "unknown" ? "Running" : w("askOnce"); right = `<button class="btn small primary" data-allow="${a.id}">${a.automation === "unknown" || OS === "win" ? "Test connection" : "Allow"}</button>`; }
    return `<div class="approw"><span class="code">${CODE[a.id]}</span><div><div class="nm">${esc(a.label)}</div><div class="sub">${esc(sub)}</div></div><div class="right">${right}</div></div>`;
  };
  const f = setup.files || {};
  const denied = ["desktop", "documents", "downloads"].filter((k) => f[k] === "denied");
  let filesRight, filesSub;
  if (!f.asked) { filesSub = "Desktop, Documents and Downloads, where your designs live"; filesRight = `<button class="btn small primary" data-files>Allow</button>`; }
  else if (denied.length) { filesSub = `Blocked: ${denied.map(cap).join(", ")}`; filesRight = `<button class="btn small" data-pane="files">Open System Settings</button>`; }
  else { filesSub = "Desktop, Documents and Downloads"; filesRight = `<span class="pill ok">${ic("check")} Allowed</span>`; }
  box.innerHTML = `<div class="applist">${(setup.apps || []).map(row).join("")}
      <div class="approw"><span class="code">${ic("folder")}</span><div><div class="nm">Design folders</div><div class="sub">${esc(filesSub)}</div></div><div class="right">${filesRight}</div></div></div>`;
  paintIcons(box);
  $$("[data-launch]", box).forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.innerHTML = `<span class="spinner"></span> Opening`;
    await postJSON("/api/setup/launch", { app: b.dataset.launch }).catch(() => {});
    for (let i = 0; i < 40; i++) { await sleep(2000); const s = await getJSON("/api/setup").catch(() => null); if (s?.apps?.find((x) => x.id === b.dataset.launch)?.running) break; }
    appsPanel(box);
  }));
  $$("[data-allow]", box).forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.innerHTML = `<span class="spinner"></span> ${w("answerPrompt")}`;
    await postJSON("/api/setup/automation", { app: b.dataset.allow }).catch(() => {});
    appsPanel(box);
  }));
  $$("[data-pane]", box).forEach((b) => (b.onclick = () => postJSON("/api/setup/settings", { pane: b.dataset.pane }).catch(() => {})));
  const fb = $("[data-files]", box);
  if (fb) fb.onclick = async () => { fb.disabled = true; fb.innerHTML = `<span class="spinner"></span> ${w("answerPrompts")}`; await postJSON("/api/setup/files").catch(() => {}); appsPanel(box); };
}

/* ---------------- settings ---------------- */
async function openSettings(section) {
  const m = $("#settings"), box = $("#settings-in");
  m.classList.add("on");
  const local = K.mode === "local";
  box.innerHTML = `<h3>Settings<button class="iconbtn" id="s-close" aria-label="Close">${ic("close")}</button></h3>
    <div class="row"><div class="lbl">AI</div><div id="s-ai"><div class="status-line"><span class="spinner"></span><span>Loading</span></div></div></div>
    <div class="row"><div class="lbl">Apps and permissions</div><div id="s-apps"></div></div>
    <div class="row"><div class="lbl">About</div>
      <div class="muted">Komposit ${esc(S.status?.version || "")} preview · ${local ? `this page is served by the app on your ${w("device")}` : `connected from the web to the app on your ${w("device")}`}<br>Your settings and chats are stored in <kbd>${esc(S.status?.dataDir || "")}</kbd></div>
      <div class="actions" style="justify-content:flex-start;margin-top:10px"><button class="btn small" id="s-rerun">Run setup again</button>${local ? "" : `<a class="btn small" href="${localCopyURL(K.port)}">${ic("external")} Open the app's own page</a>`}</div>
    </div>`;
  paintIcons(box);
  $("#s-close", box).onclick = () => m.classList.remove("on");
  $("#s-rerun", box).onclick = async () => { m.classList.remove("on"); await postJSON("/api/setup/done", { done: false }).catch(() => {}); onboarding(1); };
  appsPanel($("#s-apps", box));
  const setup = await getJSON("/api/setup?fresh=1");
  aiChooser($("#s-ai", box), setup, {
    saveLabel: "Save",
    onSaved: async () => { S.status = await getJSON("/api/status"); renderEngine(); const e = $("#f-err", box); if (e) { e.className = "ok-text"; e.textContent = "Saved."; } },
  });
  if (section === "apps") $("#s-apps", box).scrollIntoView({ block: "center" });
}

/* ---------------- composer ---------------- */
function composerHTML() {
  const segs = S.apps.map((a) => `<button data-app="${a.id}" title="${esc(APPNAME[a.id] || a.label)}" aria-label="${esc(APPNAME[a.id] || a.label)}">${appMark(a.id) || esc(CODE[a.id] || a.label)}</button>`).join("");
  return `<div class="refs" hidden></div>
    <textarea rows="1" placeholder="Describe a change to your open document"></textarea>
    <div class="tools">
      <button class="attach" title="Attach files: images, PDFs, design files, text…" aria-label="Attach files">${ic("clip")}</button>
      <input type="file" multiple hidden />
      <span class="apps appsel" role="radiogroup" aria-label="App">${segs}</span>
      <label class="effort" title="How long the AI thinks before acting">
        <input type="range" min="0" max="2" step="1" aria-label="Thinking effort" />
        <span class="effort-val"></span>
      </label>
      <span class="spacer"></span>
      ${VOICE ? `<button class="mic" title="Talk: your words appear as you speak" aria-label="Voice input">${ic("mic")}</button>` : ""}
      <button class="send" title="Send (Enter)" aria-label="Send">${ic("send")}</button>
    </div>`;
}
function wireComposer(root) {
  root.innerHTML = composerHTML();
  const ta = $("textarea", root);
  reflect(root);
  $$(".apps button", root).forEach((b) => b.addEventListener("click", () => { S.ctrl.app = b.dataset.app; reflectAll(); }));
  $(".effort input", root).addEventListener("input", (e) => { S.ctrl.effort = EFFORTS[+e.target.value] || "medium"; store.set("effort", S.ctrl.effort); reflectAll(); });
  $(".send", root).addEventListener("click", () => (S.running ? stopTurn() : send(root)));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(root); }
  });
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 200) + "px"; });
  const file = $("input[type=file]", root);
  $(".attach", root).addEventListener("click", () => file.click());
  file.addEventListener("change", () => { for (const f of file.files) addRef(f); file.value = ""; });
  ta.addEventListener("paste", (e) => { for (const it of e.clipboardData?.items || []) if (it.kind === "file") { const f = it.getAsFile(); if (f) { e.preventDefault(); addRef(f); } } });
  const mic = $(".mic", root);
  if (mic) mic.addEventListener("click", () => toggleVoice(ta, mic));
  let depth = 0;
  root.addEventListener("dragenter", (e) => { if (hasFiles(e)) { e.preventDefault(); depth++; root.classList.add("drag"); } });
  root.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  root.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; root.classList.remove("drag"); } });
  root.addEventListener("drop", (e) => { e.preventDefault(); depth = 0; root.classList.remove("drag"); for (const f of e.dataTransfer?.files || []) addRef(f); });
}
function hasFiles(e) { return [...(e.dataTransfer?.types || [])].includes("Files"); }
const OK_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_FILE = 100 * 1024 * 1024;
const IMG_LIKE = /\.(png|jpe?g|webp|gif|heic|heif|tiff?|bmp)$/i;
function addRef(f) {
  if (S.refs.length >= 6) return refNote("Up to 6 attachments per message.");
  if (f.size > MAX_FILE) return refNote(`${f.name} is over 100 MB.`);
  const isImage = f.type.startsWith("image/") && f.type !== "image/svg+xml" && (IMG_LIKE.test(f.name) || !f.name.includes("."));
  if (!isImage) {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      S.refs.push({ kind: "file", name: f.name, size: f.size, media_type: f.type || "application/octet-stream", data: url.slice(url.indexOf(",") + 1) });
      renderRefs();
    };
    r.readAsDataURL(f);
    return;
  }
  const r = new FileReader();
  r.onload = async () => {
    let url = r.result;
    // Unusual formats (HEIC, TIFF) and very large images are redrawn as PNG.
    if (!OK_TYPES.includes(f.type) || f.size > 6e6) url = await toPng(url).catch(() => null);
    if (!url) return;
    const media = url.slice(5, url.indexOf(";"));
    S.refs.push({ kind: "image", name: f.name, media_type: media, data: url.slice(url.indexOf(",") + 1), url });
    renderRefs();
  };
  r.readAsDataURL(f);
}
function toPng(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => {
      const s = Math.min(1, 2000 / Math.max(im.width, im.height));
      const c = document.createElement("canvas"); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      res(c.toDataURL("image/png"));
    };
    im.onerror = rej; im.src = src;
  });
}
function renderRefs() {
  [$("#composer-start"), $("#composer-dock")].forEach((root) => {
    const box = $(".refs", root); if (!box) return;
    box.hidden = S.refs.length === 0; box.innerHTML = "";
    S.refs.forEach((ref, i) => {
      const c = ref.kind === "file"
        ? el("div", "ref doc", `${ic("file")}<span class="fn" title="${esc(ref.name)}">${esc(ref.name)}</span><span class="fs">${fmtSize(ref.size)}</span><button class="rm" title="Remove" aria-label="Remove">${ic("x")}</button>`)
        : el("div", "ref", `<img alt="" src="${ref.url}"><button class="rm" title="Remove" aria-label="Remove">${ic("x")}</button>`);
      $(".rm", c).onclick = () => { S.refs.splice(i, 1); renderRefs(); };
      box.append(c);
    });
  });
}
function fmtSize(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`; }
function refNote(msg) {
  [$("#composer-start"), $("#composer-dock")].forEach((root) => {
    const box = root && $(".refs", root); if (!box) return;
    box.hidden = false;
    const n = el("div", "refnote", esc(msg)); box.append(n);
    setTimeout(() => { n.remove(); if (!S.refs.length) box.hidden = true; }, 4000);
  });
}

/* ---------------- voice input ----------------
   The browser's speech recognition (Chrome and Safari): words appear in the box
   as you speak, then settle as each phrase is recognised. Click again to stop. */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const VOICE = !!SR;
let voice = null;
function toggleVoice(ta, btn) {
  if (voice) { voice.stop(); return; }
  const rec = new SR();
  rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || "en-US";
  const before = ta.value && !/\s$/.test(ta.value) ? ta.value + " " : ta.value;
  let finals = "";
  const show = (interim) => {
    ta.value = before + finals + interim;
    ta.dispatchEvent(new Event("input"));
    ta.scrollTop = ta.scrollHeight;
  };
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finals += t; else interim += t;
    }
    show(interim);
  };
  const done = () => { voice = null; $$(".mic").forEach((b) => { b.classList.remove("rec"); b.title = "Talk: your words appear as you speak"; }); show(""); ta.focus(); };
  rec.onend = done;
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") refNote("Microphone blocked. Allow it for this page in the browser's site settings.");
    else if (e.error === "no-speech") refNote("Didn't hear anything.");
    else if (e.error !== "aborted") refNote("Voice input stopped: " + e.error);
  };
  try { rec.start(); } catch { return; }
  voice = rec;
  btn.classList.add("rec"); btn.title = "Stop listening";
}

function reflect(root) {
  $$(".apps button", root).forEach((b) => b.classList.toggle("on", b.dataset.app === S.ctrl.app));
  const ef = $(".effort input", root);
  if (ef) { const i = Math.max(0, EFFORTS.indexOf(S.ctrl.effort)); ef.value = i; ef.style.setProperty("--p", i / 2); $(".effort-val", root).textContent = EFFORT[S.ctrl.effort] || "Balanced"; }
}
function reflectAll() { [$("#composer-start"), $("#composer-dock")].forEach((r) => r && reflect(r)); }
function setSendButtons(running) {
  $$(".send").forEach((b) => { b.innerHTML = ic(running ? "stop" : "send"); b.classList.toggle("stop", running); b.title = running ? "Stop" : "Send (Enter)"; });
}

/* ---------------- workspace ---------------- */
let wsLoadedAt = 0;
function newDocCard() {
  const nc = el("div", "file new", `<div class="inner">${ic("plus")}<span>New document</span></div>`);
  nc.onclick = () => openNewDoc();
  return nc;
}
async function loadWorkspace() {
  wsLoadedAt = Date.now();
  browseDir(sidebarDir);
  const fw = $("#files");
  if (!fw.children.length) fw.append(newDocCard());
  let ws;
  try { ws = await getJSON("/api/workspace"); } catch { return; }
  if (!S.appAutoSet) {
    const open = (ws.apps || []).find((a) => a.running);
    if (open) { S.ctrl.app = open.id; reflectAll(); }
    S.appAutoSet = true;
  }
  const files = ws.recentFiles || [];
  fw.innerHTML = "";
  fw.append(newDocCard());
  files.slice(0, 5).forEach((f) => {
    const card = el("div", "file" + (f.open ? " is-open" : ""));
    card.innerHTML = `<div class="thumb"><span class="ph">${esc(CODE[f.app] || f.ext.slice(1).toUpperCase())}</span></div>
      <span class="badge">${esc(CODE[f.app] || f.ext.slice(1))}${f.open ? `<span class="on">Open</span>` : ""}</span><span class="nm">${esc(f.name)}</span>`;
    const img = new Image(); img.alt = "";
    img.onload = () => { const t = $(".thumb", card); t.innerHTML = ""; t.append(img); };
    setImg(img, "/api/thumb?path=" + encodeURIComponent(f.path) + "&m=" + Math.round(f.mtime));
    card.onclick = () => openFile(f);
    card.title = f.open ? `${f.name} (open in ${APPNAME[f.app]})` : f.name;
    fw.append(card);
  });
}

let sidebarDir = null;
async function browseDir(dir) {
  let b;
  try { b = await getJSON("/api/files" + (dir ? "?dir=" + encodeURIComponent(dir) : "")); } catch { return; }
  sidebarDir = b.cwd;
  const sf = $("#sidefiles"); sf.innerHTML = "";
  const crumb = el("div", "sfile crumb", `<span class="code">${ic(b.parent ? "back" : "folder")}</span><span class="nm">${esc(b.name)}</span>`);
  crumb.onclick = () => b.parent && browseDir(b.parent);
  sf.append(crumb);
  if (b.denied) {
    const n = el("div", "sidenote", `Komposit can't read this folder yet. <a href="#" id="sf-allow">Allow access</a>`);
    sf.append(n);
    $("#sf-allow", n).onclick = (e) => { e.preventDefault(); openSettings("apps"); };
    return;
  }
  b.dirs.forEach((d) => { const r = el("div", "sfile", `<span class="code">${ic("folder")}</span><span class="nm">${esc(d.name)}</span>`); r.onclick = () => browseDir(d.path); sf.append(r); });
  b.files.forEach((f) => { const r = el("div", "sfile", `<span class="code">${esc(CODE[f.app] || f.ext.slice(1).toUpperCase())}</span><span class="nm">${esc(f.name)}</span>`); r.title = f.name; r.onclick = () => openFile(f); sf.append(r); });
}

async function openFile(f) {
  S.ctrl.app = f.app; reflectAll();
  const ta = S.cur ? $("#composer-dock textarea") : $("#composer-start textarea");
  if (ta && !ta.value.trim()) { ta.value = `In "${f.name}": `; ta.focus(); }
  try { await postJSON("/api/open", { path: f.path, app: f.app }); } catch {}
  setTimeout(() => { if (!S.cur) loadWorkspace(); }, 5000);
}

/* new document */
const PRESETS = [
  { label: "Square · 1080", w: 1080, h: 1080 },
  { label: "Portrait · 1080×1350", w: 1080, h: 1350 },
  { label: "HD · 1920×1080", w: 1920, h: 1080 },
  { label: "A4 · 2480×3508", w: 2480, h: 3508 },
];
let mApp = "illustrator";
function openNewDoc() {
  mApp = S.ctrl.app;
  $("#m-err").textContent = "";
  const seg = $("#m-apps");
  seg.innerHTML = S.apps.map((a) => `<button data-app="${a.id}" class="${a.id === mApp ? "on" : ""}">${CODE[a.id] || esc(a.label)}</button>`).join("");
  $$("#m-apps button").forEach((b) => (b.onclick = () => { mApp = b.dataset.app; $$("#m-apps button").forEach((x) => x.classList.toggle("on", x === b)); }));
  const pw = $("#m-presets");
  pw.innerHTML = PRESETS.map((p, i) => `<button class="preset ${i === 0 ? "on" : ""}" data-w="${p.w}" data-h="${p.h}">${p.label}</button>`).join("");
  const setDims = (w, h) => { $("#m-w").value = w; $("#m-h").value = h; };
  setDims(PRESETS[0].w, PRESETS[0].h);
  $$("#m-presets .preset").forEach((b) => (b.onclick = () => { $$("#m-presets .preset").forEach((x) => x.classList.toggle("on", x === b)); setDims(b.dataset.w, b.dataset.h); }));
  [$("#m-w"), $("#m-h")].forEach((inp) => (inp.oninput = () => $$("#m-presets .preset").forEach((x) => x.classList.remove("on"))));
  $("#newdoc").classList.add("on");
}
async function createNewDoc() {
  const app = mApp, width = Math.max(1, +$("#m-w").value || 1080), height = Math.max(1, +$("#m-h").value || 1080);
  const btn = $("#m-create"); btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Creating`;
  try {
    const r = await postJSON("/api/new", { app, opts: { width, height } });
    if (!r.ok) { $("#m-err").textContent = r.error || "Couldn't create the document."; return; }
    $("#newdoc").classList.remove("on");
    S.ctrl.app = app; reflectAll();
    const ta = S.cur ? $("#composer-dock textarea") : $("#composer-start textarea");
    if (ta) ta.focus();
  } catch (e) { $("#m-err").textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = "Create"; }
}

/* ---------------- chats ---------------- */
async function loadChats() {
  try { S.chats = (await getJSON("/api/chats")).chats || []; } catch { return; }
  renderHistory();
}
function renderHistory() {
  const h = $("#history"); h.innerHTML = "";
  if (!S.chats.length) { h.append(el("div", "sidenote", "Your chats appear here.")); return; }
  S.chats.forEach((c) => {
    const row = el("div", "chat" + (c.id === S.cur ? " active" : ""));
    if (S.running && S.running.chatId === c.id) row.append(el("span", "live"));
    row.append(el("span", "t", esc(c.title || "Untitled")));
    row.title = c.title || "";
    const x = el("button", "x iconbtn", ic("x")); x.title = "Delete chat"; x.setAttribute("aria-label", "Delete chat");
    x.onclick = async (e) => {
      e.stopPropagation();
      if (x.dataset.armed !== "1") { x.dataset.armed = "1"; x.innerHTML = `<span style="font-size:11px;font-family:var(--mono)">Delete?</span>`; setTimeout(() => { if (x.isConnected) { x.dataset.armed = ""; x.innerHTML = ic("x"); } }, 2500); return; }
      await api(`/api/chats/${c.id}`, { method: "DELETE" }).catch(() => {});
      if (S.cur === c.id) newChat(); else loadChats();
    };
    row.append(x);
    row.onclick = () => openChat(c.id);
    h.append(row);
  });
}

function showConversation() { document.querySelector("main").classList.remove("home"); $("#start").hidden = true; $("#convo").hidden = false; $("#dock").hidden = false; }
function showStart() { document.querySelector("main").classList.add("home"); $("#transcript").innerHTML = ""; $("#convo").hidden = true; $("#dock").hidden = true; $("#start").hidden = false; }

function newChat() {
  if (S.running) stopTurn();
  S.cur = null; store.del("chat");
  showStart();
  const ta = $("#composer-start textarea"); if (ta) { ta.value = ""; ta.focus(); }
  renderHistory(); loadWorkspace();
}

let pollTimer = null;
async function openChat(id) {
  if (S.running && S.running.chatId !== id) { /* keep the other turn running server-side */ }
  clearTimeout(pollTimer);
  let d;
  try { d = await getJSON(`/api/chats/${id}`); } catch { return; }
  if (!d.chat) return;
  S.cur = id; store.set("chat", id);
  showConversation();
  const tr = $("#transcript"); tr.innerHTML = "";
  for (const t of d.chat.turns) {
    const v = turnView(storedToVM(id, t));
    tr.append(v.userEl, v.turnEl);
  }
  if (d.chat.turns.length) { const last = d.chat.turns[d.chat.turns.length - 1]; S.ctrl.app = last.app || S.ctrl.app; reflectAll(); }
  renderHistory();
  scrollEnd(true);
  if (d.running && !(S.running && S.running.chatId === id)) pollChat(id);
}
// A turn still running after a reload: refresh it until it finishes.
function pollChat(id) {
  pollTimer = setTimeout(async () => {
    if (S.cur !== id) return;
    let d; try { d = await getJSON(`/api/chats/${id}`); } catch { return; }
    const tr = $("#transcript"); tr.innerHTML = "";
    for (const t of d.chat.turns) { const v = turnView(storedToVM(id, t)); tr.append(v.userEl, v.turnEl); }
    scrollEnd();
    if (d.running) pollChat(id); else loadChats();
  }, 2000);
}

/* ---------------- turns ---------------- */
function storedToVM(chatId, t) {
  const img = (n) => (n ? `/api/chats/${chatId}/img/${n}` : null);
  return {
    status: t.status || "done",
    started: t.at,
    durationMs: t.durationMs,
    app: t.app, effort: t.effort, engine: t.engine,
    user: { text: t.user?.text || "", images: (t.user?.images || []).map(img), files: t.user?.files || [] },
    steps: (t.steps || []).map((s) => ({ ...s, imageUrl: img(s.image), videoUrl: img(s.video) })),
    final: t.final || "",
    error: t.error ? { message: t.error, code: t.errorCode || null } : null,
    liveText: "",
  };
}

function turnView(vm, { localImages } = {}) {
  const userEl = el("div", "user");
  const imgs = localImages || vm.user.images;
  if (imgs.length) {
    const box = el("div", "refimgs");
    imgs.forEach((src) => {
      const im = new Image(); im.alt = "Reference";
      if (localImages) im.src = src; else setImg(im, src);
      im.onclick = () => lightbox(im.src);
      box.append(im);
    });
    userEl.append(box);
  }
  if (vm.user.files?.length) {
    const box = el("div", "reffiles");
    vm.user.files.forEach((f) => box.append(el("span", "chip", `${ic("file")}<span class="fn">${esc(f.name)}</span><span class="fs">${fmtSize(f.size)}</span>`)));
    userEl.append(box);
  }
  if (vm.user.text) userEl.append(document.createTextNode(vm.user.text));
  const turnEl = el("div", "turn");
  const v = { vm, userEl, turnEl, timer: null };
  paintTurn(v);
  if (vm.status === "running") v.timer = setInterval(() => paintHead(v), 200);
  return v;
}

const ENGINE_LABEL = { "claude-code": "Claude subscription", codex: "ChatGPT subscription", anthropic: "Anthropic API", openai: "OpenAI-compatible", invite: "Invite" };

function currentLabel(vm) {
  const running = [...vm.steps].reverse().find((s) => s.kind === "tool" && s.status === "running");
  if (running?.waiting) return running.waiting;
  if (running) return running.label;
  const base = vm.steps.length ? "Thinking about the next step" : "Thinking";
  // How much it has thought so far (Claude Code), so a long plan visibly moves.
  if (vm.thinkTokens > 0) {
    const long = !vm.steps.length && Date.now() - vm.started > 20000;
    return `${long ? "Planning the whole change" : base} · ${vm.thinkTokens.toLocaleString("en-US")} tokens`;
  }
  return base;
}

function paintHead(v) {
  const { vm } = v;
  const head = $(".activity-head", v.turnEl);
  if (!head) return;
  const elapsed = vm.status === "running" ? Date.now() - vm.started : vm.durationMs || 0;
  const tools = vm.steps.filter((s) => s.kind === "tool").length;
  let icon, label;
  if (vm.status === "running") { icon = `<span class="spinner"></span>`; label = currentLabel(vm); }
  else if (vm.status === "stopped") { icon = ic("stopped"); label = "Stopped"; }
  else if (vm.status === "error" && !vm.final) { icon = ic("alert"); label = tools ? `${tools} step${tools === 1 ? "" : "s"}, then a problem` : "Couldn't finish"; }
  else { icon = ic("checkCircle"); label = tools ? `${tools} step${tools === 1 ? "" : "s"}` : "Answered"; }
  head.innerHTML = `${icon}<span class="ah-lbl">${esc(label)}</span><span class="tm">${fmtDur(elapsed)}</span>${vm.steps.length ? ic("chev").replace('class="ic"', 'class="ic chev"') : ""}`;
}

function paintTurn(v) {
  const { vm, turnEl } = v;
  // Open while working; afterwards closed unless the person opened it.
  const isOpen = vm.userOpen ?? vm.status === "running";
  turnEl.innerHTML = "";

  // Activity: what it did, step by step.
  if (vm.status === "running" || vm.steps.length) {
    const act = el("div", "activity" + (isOpen ? " open" : ""));
    const head = el("div", "activity-head");
    act.append(head);
    const bodyEl = el("div", "activity-body");
    for (const s of vm.steps) {
      if (s.kind === "note") { bodyEl.append(el("div", "act note", `<span class="st">${ic("dot")}</span><span class="txt">${esc(s.text)}</span>`)); continue; }
      const st = s.status === "running" ? `<span class="spinner"></span>` : ic(s.status === "done" ? "check" : s.status === "stopped" ? "stopped" : "x");
      const row = el("div", `act ${s.status || ""}`, `<span class="st">${st}</span><span class="txt">${esc(s.label || s.name)}${s.detail || s.waiting ? `<span class="detail">${esc(s.detail || s.waiting)}</span>` : ""}</span>`);
      if (s.imageUrl) { const im = el("img", "mini"); im.alt = ""; setImg(im, s.imageUrl); im.onclick = (e) => { e.stopPropagation(); lightbox(im.src); }; row.append(im); }
      if (s.ms != null && s.status !== "running") row.append(el("span", "ms", fmtDur(s.ms)));
      bodyEl.append(row);
    }
    if (!vm.steps.length) bodyEl.append(el("div", "act note", `<span class="st">${ic("dot")}</span><span class="txt">Reading your request</span>`));
    act.append(bodyEl);
    head.onclick = () => { act.classList.toggle("open"); vm.userOpen = act.classList.contains("open"); };
    turnEl.append(act);
    v.turnEl = turnEl;
    paintHead(v);
  }

  // Result: the latest render of the document, or the motion preview when the
  // latest one is a video (After Effects).
  const last = [...vm.steps].reverse().find((s) => (s.imageUrl || s.videoUrl) && s.status === "done");
  if (last?.videoUrl && vm.status !== "running") {
    const res = el("div", "result", `<div class="cap">Result</div>`);
    const v = document.createElement("video");
    Object.assign(v, { muted: true, loop: true, autoplay: true, playsInline: true, controls: true });
    v.setAttribute("aria-label", "Preview of the animation");
    authURL(last.videoUrl).then((u) => { v.src = u; }).catch(() => {});
    res.append(v);
    turnEl.append(res);
  } else if (last && vm.status !== "running") {
    const res = el("div", "result", `<div class="cap">Result</div>`);
    const im = new Image(); im.alt = "Render of the document";
    setImg(im, last.imageUrl);
    im.onclick = () => lightbox(im.src);
    res.append(im);
    turnEl.append(res);
  }

  // Message.
  if (vm.final) turnEl.append(el("div", "prose", md(vm.final)));
  else if (vm.liveText) turnEl.append(el("div", "prose stream", esc(vm.liveText)));

  // Problems, with a way forward.
  const automationBlocked = vm.steps.some((s) => /not allowed to control|Automation/i.test(s.detail || ""));
  if (vm.error || automationBlocked) {
    const msg = vm.error ? vm.error.message : "macOS is blocking Komposit from controlling this app.";
    const n = el("div", "notice err", `<div>${esc(msg)}</div>`);
    const row = el("div", "row");
    const code = vm.error?.code;
    if (automationBlocked || /not allowed to control/i.test(msg)) {
      const b = el("button", "btn small", "Open System Settings"); b.onclick = () => postJSON("/api/setup/settings", { pane: "automation" }).catch(() => {}); row.append(b);
    }
    if (["claude_missing", "claude_auth", "claude_broken", "codex_missing", "codex_auth", "codex_broken", "auth", "permission", "setup_required"].includes(code)) {
      const b = el("button", "btn small", "Open Settings"); b.onclick = () => openSettings(); row.append(b);
    }
    if (row.children.length) n.append(row);
    turnEl.append(n);
  }

  // Footer: how long it took (time, never cost).
  if (vm.status !== "running") {
    const bits = [`${ic("clock")}${fmtDur(vm.durationMs || 0)}`];
    if (vm.effort) bits.push(esc(EFFORT[vm.effort] || vm.effort));
    if (vm.engine) bits.push(esc(ENGINE_LABEL[vm.engine] || vm.engine));
    if (vm.app) bits.push(esc(APPNAME[vm.app] || vm.app));
    turnEl.append(el("div", "turn-foot", bits.join(" · ")));
  }
}

function lightbox(src) { if (!src) return; $("#lbimg").src = src; $("#lb").classList.add("on"); }

function scrollEnd(force) {
  const s = $("#scroll");
  const near = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  if (force || near) s.scrollTop = s.scrollHeight;
}

async function send(root) {
  const ta = $("textarea", root);
  const text = ta.value.trim();
  if ((!text && !S.refs.length) || S.running) return;
  if (voice) voice.stop();
  const { app, effort } = S.ctrl;
  const imgRefs = S.refs.filter((r) => r.kind !== "file"), fileRefs = S.refs.filter((r) => r.kind === "file");
  const images = imgRefs.map((r) => ({ media_type: r.media_type, data: r.data }));
  const files = fileRefs.map((r) => ({ name: r.name, media_type: r.media_type, data: r.data }));
  const localImages = imgRefs.map((r) => r.url);
  const localFiles = fileRefs.map((r) => ({ name: r.name, size: r.size }));
  ta.value = ""; ta.style.height = "auto"; S.refs = []; renderRefs();

  showConversation();
  const vm = { status: "running", started: Date.now(), app, effort, engine: S.status?.ai?.mode, user: { text, images: [], files: localFiles }, steps: [], final: "", error: null, liveText: "" };
  const v = turnView(vm, { localImages });
  $("#transcript").append(v.userEl, v.turnEl);
  scrollEnd(true);

  const controller = new AbortController();
  const isNewChat = !S.cur;
  let named = false; // the AI's title for a new chat arrived
  S.running = { controller, chatId: S.cur };
  setSendButtons(true);
  const repaint = () => { paintTurn(v); scrollEnd(); };

  try {
    const res = await api("/api/turn", { method: "POST", body: { chatId: S.cur || undefined, app, effort, text, images, files }, signal: controller.signal });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      vm.error = { message: j.message || j.error || `Komposit answered ${res.status}.`, code: j.error === "setup_required" ? "setup_required" : null };
      vm.status = "error";
    } else {
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!frame.startsWith("data:")) continue;
          let ev; try { ev = JSON.parse(frame.slice(5)); } catch { continue; }
          onEvent(ev);
        }
      }
    }
  } catch (e) {
    if (controller.signal.aborted) vm.status = "stopped";
    else if (!(e instanceof NotPaired)) { vm.error = { message: "Lost the connection to Komposit. Is the app still running?", code: "network" }; vm.status = "error"; }
  } finally {
    if (vm.status === "running") vm.status = vm.error ? "error" : "done";
    if (!vm.durationMs) vm.durationMs = Date.now() - vm.started;
    clearInterval(v.timer);
    S.running = null;
    setSendButtons(false);
    repaint();
    loadChats();
    // A quick first turn can end before the AI has named the chat: look again.
    if (isNewChat && !named) [4000, 12000].forEach((ms) => setTimeout(() => { if (!named) loadChats(); }, ms));
  }

  function onEvent(ev) {
    switch (ev.type) {
      case "start":
        S.cur = ev.chatId; S.running.chatId = ev.chatId; store.set("chat", ev.chatId);
        if (!S.chats.find((c) => c.id === ev.chatId)) { S.chats.unshift({ id: ev.chatId, title: ev.title }); renderHistory(); }
        break;
      case "title": {
        named = true;
        const c = S.chats.find((x) => x.id === ev.chatId);
        if (c) { c.title = ev.title; renderHistory(); }
        break;
      }
      case "thinking": vm.thinkTokens = ev.tokens; break;
      case "note": vm.liveText = ""; vm.thinkTokens = 0; vm.steps.push({ kind: "note", text: ev.text }); break;
      case "text": vm.liveText += ev.delta; break;
      case "step": vm.liveText = ""; vm.thinkTokens = 0; vm.steps.push({ kind: "tool", id: ev.id, name: ev.name, label: ev.label, status: "running" }); break;
      case "step_wait": {
        const s = vm.steps.find((x) => x.kind === "tool" && x.id === ev.id);
        if (s) s.waiting = ev.text || null;
        break;
      }
      case "step_done": {
        const s = vm.steps.find((x) => x.kind === "tool" && x.id === ev.id);
        if (s) Object.assign(s, { status: ev.status, label: ev.label, ms: ev.ms, detail: ev.detail, imageUrl: ev.imageUrl || s.imageUrl, videoUrl: ev.videoUrl || s.videoUrl, waiting: null });
        break;
      }
      case "final":
        if (ev.dropLastNote) { const l = vm.steps[vm.steps.length - 1]; if (l && l.kind === "note") vm.steps.pop(); }
        vm.final = ev.text; vm.liveText = "";
        break;
      case "error": vm.error = { message: ev.message, code: ev.code }; break;
      case "done": vm.status = ev.status; vm.durationMs = ev.durationMs; break;
      default: return;
    }
    repaint();
  }
}

async function stopTurn() {
  const r = S.running;
  if (!r) return;
  try { if (r.chatId) await postJSON("/api/stop", { chatId: r.chatId }); } catch {}
  r.controller.abort();
}

/* ---------------- wiring ---------------- */
function wireStatic() {
  paintIcons();
  $("#collapse").innerHTML = ic("sidebar");
  $("#expand").innerHTML = ic("sidebar");
  $("#new").onclick = newChat;
  $("#collapse").onclick = () => document.body.classList.add("collapsed");
  $("#expand").onclick = () => document.body.classList.remove("collapsed");
  $$(".sidehead").forEach((h) => (h.onclick = () => $("#" + h.dataset.toggle).classList.toggle("closed")));
  $("#open-settings").onclick = () => openSettings();
  $("#lb").onclick = () => $("#lb").classList.remove("on");
  $("#m-cancel").onclick = () => $("#newdoc").classList.remove("on");
  $("#m-create").onclick = createNewDoc;
  $("#newdoc").onclick = (e) => { if (e.target.id === "newdoc") $("#newdoc").classList.remove("on"); };
  $("#settings").onclick = (e) => { if (e.target.id === "settings") $("#settings").classList.remove("on"); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("#lb").classList.remove("on"); $("#newdoc").classList.remove("on"); $("#settings").classList.remove("on"); } });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("focus", () => { if (!document.body.classList.contains("gated") && !S.cur && Date.now() - wsLoadedAt > 8000) loadWorkspace(); });
}

function boot() {
  wireStatic();
  const tok = meta("komposit-token");
  if (tok) {
    K.mode = "local"; K.token = tok; K.base = ""; K.port = Number(meta("komposit-port")) || Number(location.port) || 4321;
    return connected();
  }
  return hostedConnect();
}

boot();
