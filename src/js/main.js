// src/js/main.js (minimal)
document.getElementById('year')?.append(new Date().getFullYear().toString());
const path = location.pathname.replace(/index\.html$/, '');
document.querySelectorAll('.nav a').forEach(a => {
  const href = a.getAttribute('href');
  if (!href) return;
  if (href === '/' && path === '/') a.classList.add('active');
  else if (href !== '/' && path.endsWith(href)) a.classList.add('active');
});