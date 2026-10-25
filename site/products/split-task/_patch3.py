import io

p = 'index.html'
s = io.open(p, encoding='utf-8-sig').read()

# Quick add -> blue
s = s.replace(
    '<div class="feat-card prod-card--android">\n            <span class="feat-icon" aria-hidden="true">\n              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12z"/></svg>',
    '<div class="feat-card prod-card--blue">\n            <span class="feat-icon" aria-hidden="true">\n              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12z"/></svg>')

# Reminders -> purple
s = s.replace(
    '<div class="feat-card prod-card--brass">\n            <span class="feat-icon" aria-hidden="true">\n              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>',
    '<div class="feat-card prod-card--purple">\n            <span class="feat-icon" aria-hidden="true">\n              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>')

# Account deletion -> red
s = s.replace(
    'class="policy-card pol-card prod-card--brass" href="https://manumit.studio/products/split-task/app/#/delete"',
    'class="policy-card pol-card prod-card--red" href="https://manumit.studio/products/split-task/app/#/delete"')

io.open(p, 'w', encoding='utf-8').write(s)
print('done')
