
// Set year
document.getElementById('year')?.append(new Date().getFullYear().toString());

// Highlight active nav link
const path = location.pathname.replace(/index\.html$/, '');
for (const a of document.querySelectorAll('.nav a')) {
  const href = a.getAttribute('href');
  if (!href) continue;
  if (href === '/' && path === '/') a.classList.add('active');
  else if (href !== '/' && path.endsWith(href)) a.classList.add('active');
}
