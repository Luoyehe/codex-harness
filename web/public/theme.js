// Apply the saved preference before the browser paints the application shell.
try {
  const theme = localStorage.getItem('harness.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* Storage is optional in restricted browser sessions. */ }
