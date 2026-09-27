/* Sets <html data-theme> before the first paint, so the page never flashes the
   wrong theme. A stored choice ('light' / 'dark') wins; without one the theme
   follows the system. Same key and rule as Isar's other apps, so a choice carries over.
   A separate file, not inline: the app's CSP allows scripts from 'self' only. */
try {
  var t = localStorage.getItem('isar-theme')
  document.documentElement.setAttribute(
    'data-theme',
    t === 'light' || t === 'dark' ? t : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  )
} catch (e) {
  document.documentElement.setAttribute('data-theme', 'dark')
}
