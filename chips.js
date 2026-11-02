// Multi-pick field for the review page (assignees, labels): a fuzzy dropdown whose picks show as removable chips.
// The list closes after each pick. When the options can't be listed, it turns into a comma-separated text field.
import { createCombo } from './combo.js';

// opts:
//   prefix       element ids: <prefix>Input, Options, Toggle, Combo, Chips, Text, Hint, Count
//   max          most picks allowed, and maxText(max) shown when it's reached
//   placeholder  { none, some, full } input placeholders for 0 picks, some picks, and the limit reached
//   emptyText(query, options)  text for an empty list
//   noneText     hint when there are no options at all
//   splitText(text)  turns the text-field fallback into values
export function createChipPicker(opts) {
  const el = (s) => document.getElementById(opts.prefix + s);
  const input = el('Input');
  let options = [];
  let picked = [];

  const combo = createCombo({
    input,
    listbox: el('Options'),
    toggle: el('Toggle'),
    container: el('Combo'),
    items: () => options.filter((v) => !picked.includes(v)),
    onPick: pick,
    emptyText: (q) => opts.emptyText(q, options),
  });

  function pick(value) {
    if (picked.length >= opts.max) el('Hint').textContent = opts.maxText(opts.max);
    else if (!picked.includes(value)) picked.push(value);
    input.value = '';
    renderChips();
  }

  function unpick(value) {
    picked = picked.filter((v) => v !== value);
    el('Hint').textContent = '';
    renderChips();
    combo.refresh(); // it's pickable again
  }

  function renderChips() {
    el('Chips').replaceChildren(...picked.map((value) => {
      const li = document.createElement('li');
      const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '×' });
      remove.setAttribute('aria-label', `Remove ${value}`);
      remove.addEventListener('click', () => { unpick(value); input.focus(); });
      li.append(value, remove);
      return li;
    }));
    // the list closes after each pick, so say that more can be added
    const p = opts.placeholder;
    input.placeholder = picked.length >= opts.max ? p.full : picked.length ? p.some : p.none;
    updateCount();
  }

  const values = () => (el('Text').hidden ? [...picked] : opts.splitText(el('Text').value));

  function updateCount() {
    const n = values().length;
    el('Count').textContent = n ? `· ${n} selected` : '';
  }

  // Backspace in the empty field removes the last pick
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && picked.length) unpick(picked[picked.length - 1]);
  });

  return {
    values,
    setOptions(list, selected) {
      options = list;
      picked = selected.filter((v) => list.includes(v));
      input.value = '';
      combo.close();
      el('Combo').hidden = false;
      el('Chips').hidden = false;
      el('Text').hidden = true;
      el('Hint').textContent = list.length ? '' : opts.noneText;
      renderChips();
    },
    useText(hint, value = []) {
      combo.close();
      el('Combo').hidden = true;
      el('Chips').hidden = true;
      el('Text').hidden = false;
      el('Text').value = value.join(', ');
      el('Hint').textContent = hint;
      el('Count').textContent = '';
    },
    loading(text) { el('Hint').textContent = text; },
  };
}
