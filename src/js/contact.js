
const form = document.getElementById('contact-form');
const statusEl = document.getElementById('contact-status');

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = 'Sending...';
  const fd = new FormData(form);
  const payload = Object.fromEntries(fd.entries());
  const tokenInput = document.querySelector('[name="cf-turnstile-response"]');
  const turnstileToken = tokenInput ? tokenInput.value : '';
  try {
    const res = await fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, turnstileToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      statusEl.textContent = data.message || 'Thanks! Your message has been sent.';
      form.reset();
      if (window.turnstile) window.turnstile.reset();
    } else {
      statusEl.textContent = data.error || 'Sorry, something went wrong.';
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Sorry, something went wrong.';
  }
});
