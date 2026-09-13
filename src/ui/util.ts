// Small DOM helpers shared by the UI views.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === undefined) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fieldset(
  legend: string,
  body: HTMLElement,
): HTMLElement {
  const ls = el('legend', { text: legend });
  return el('fieldset', {}, ls, body);
}

// A labeled single-line input.
export function inputRow(
  label: string,
  input: HTMLInputElement | HTMLSelectElement,
): HTMLElement {
  return el('label', { class: 'input-row' }, el('span', { text: label }), input);
}

// Read a numeric field, treating '' as undefined.
export function intOrUndefined(v: string): number | undefined {
  const s = v.trim();
  if (s === '') return undefined;
  if (/^0x/i.test(s)) return Number.parseInt(s.slice(2), 16);
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

// Format a numeric value for a text input ('' for the "unspecified"
// subaddress).
export function fmtInt(v: number | undefined): string {
  return v === undefined || v === -1 ? '' : String(v);
}

export function protocolNames(converter: { getProtocols(): { name: string }[] }): string[] {
  return converter.getProtocols().map((p) => p.name);
}

export function slugify(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'remote';
}

export function downloadText(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('Clipboard not available'));
}

// A small button that copies `text` to the clipboard and flips its label to
// "Copied" briefly so the feedback stays in place for each copied control.
export function copyButton(text: string, label = 'Copy'): HTMLButtonElement {
  const btn = el('button', { type: 'button', class: 'copy-btn', text: label });
  btn.addEventListener('click', () => {
    copyText(text)
      .then(() => {
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = label; }, 1200);
      })
      .catch((e) => alert(`Could not copy: ${(e as Error).message}`));
  });
  return btn;
}
