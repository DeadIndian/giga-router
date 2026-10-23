// Everything here is a local illustration or a clipboard interaction.
const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
const mobile = window.matchMedia('(max-width: 650px)');
function closeMenu() {
  navigation.hidden = mobile.matches;
  menuButton.hidden = !mobile.matches;
  menuButton.setAttribute('aria-expanded', 'false');
}
closeMenu();
mobile.addEventListener('change', closeMenu);
menuButton.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  navigation.hidden = !open;
});
navigation.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') { closeMenu(); menuButton.focus(); }
});

function wireTabs(list, select) {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const activate = tab => {
    for (const item of tabs) { item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1; }
    select(tab);
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      let index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault(); activate(tabs[index]); tabs[index].focus();
    });
  }
}
const scenarios = {
  priority: { intent: 'profile/coding', summary: 'Your priority order. The first eligible provider gets the request.', rows: [
    ['selected', 'Selected', 'First eligible provider in your chain'], ['standby', 'Standby', 'Ready when you need it'], ['standby', 'Standby', 'Next in the fallback chain'],
  ] },
  fallback: { intent: 'profile/coding', summary: 'A failure before output? Try the next eligible provider in your chain.', rows: [
    ['skipped', 'Cooling down', 'Startup request failed · temporarily skipped'], ['selected', 'Selected', 'Next eligible provider takes the request'], ['standby', 'Standby', 'Still available as a fallback'],
  ] },
  capabilities: { intent: 'image input required', summary: 'Known capability mismatches are skipped before a request is sent.', rows: [
    ['skipped', 'Skipped', 'This model does not support image input'], ['selected', 'Selected', 'Vision enabled · ready for this request'], ['standby', 'Standby', 'Next compatible option'],
  ] },
};
wireTabs(document.querySelector('.demo-tabs'), tab => {
  const scenario = scenarios[tab.dataset.scenario];
  document.querySelector('#route-intent').textContent = scenario.intent;
  document.querySelector('#route-summary span').textContent = scenario.summary;
  document.querySelector('#route-example').setAttribute('aria-labelledby', tab.id);
  document.querySelectorAll('.route-row').forEach((row, index) => {
    const [state, label, detail] = scenario.rows[index];
    row.dataset.state = state; row.querySelector('.route-state').textContent = label; row.querySelector('.route-detail').textContent = detail;
  });
});
wireTabs(document.querySelector('.install-tabs'), tab => {
  for (const panel of document.querySelectorAll('.install-card [role="tabpanel"]')) panel.hidden = panel.id !== tab.getAttribute('aria-controls');
});

for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', async () => {
  const code = document.getElementById(button.dataset.copy);
  let copied = false;
  try { await navigator.clipboard.writeText(code.textContent.trim()); copied = true; }
  catch {
    const area = document.createElement('textarea'); area.value = code.textContent.trim();
    area.style.cssText = 'position:fixed;left:0;top:0;opacity:0';
    document.body.append(area); area.select();
    try { copied = document.execCommand('copy'); }
    catch { copied = false; }
    finally { area.remove(); button.focus(); }
  }
  button.querySelector('span').textContent = copied ? 'Copied!' : 'Select text';
  document.querySelector('#copy-status').textContent = copied ? 'Commands copied to clipboard.' : 'Clipboard unavailable. Select and copy the commands from the terminal block.';
  setTimeout(() => { button.querySelector('span').textContent = 'Copy'; }, 2000);
});
