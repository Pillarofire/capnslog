document.documentElement.dataset.theme = localStorage.getItem('notebook.theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
