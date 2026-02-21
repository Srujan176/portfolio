
// Set year
document.getElementById('year')?.append(new Date().getFullYear().toString());
// Highlight active nav
const path = location.pathname.replace(/index\.html$/, '');
document.querySelectorAll('.nav a').forEach(a=>{ const href=a.getAttribute('href'); if(!href) return; if (href === '/' && path === '/') a.classList.add('active'); else if (href !== '/' && path.endsWith(href)) a.classList.add('active'); });
// Geo greeting
(async () => {
  try {
    const tag = document.querySelector('.tagline');
    if (!tag) return;
    const res = await fetch('/whoami', { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) return;
    const info = await res.json();
    const tz = info?.timezone;
    const where = (info?.city && info?.country) ? `${info.city}, ${info.country}` : (info?.country || '');
    if (tz) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = `We’ll reply in your timezone (${tz})${where ? ` — hello from ${where}!` : ''}`;
      tag.insertAdjacentElement('afterend', p);
    }
  } catch {}
})();
