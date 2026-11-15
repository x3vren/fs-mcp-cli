const esc = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
export const c = { dim: esc(2), bold: esc(1), red: esc(31), green: esc(32), yellow: esc(33), magenta: esc(35), cyan: esc(36) };

export function spinner(label) {
  if (!process.stdout.isTTY) return () => {};
  const f = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let done = false;
  const id = setInterval(() => process.stdout.write(`\r${c.cyan(f[i++ % f.length])} ${c.dim(label + '…')}`), 80);
  return () => {
    if (done) return;
    done = true;
    clearInterval(id);
    process.stdout.write('\r\x1b[K');
  };
}

/** Rendu Markdown léger ligne par ligne, utilisable en streaming. `write` reçoit le texte formaté. */
export function mdStream(write) {
  let buf = '';
  let fence = false;
  const line = (l) => {
    if (/^\s*```/.test(l)) { fence = !fence; write(c.dim(l) + '\n'); return; }
    if (fence) { write(c.cyan(l) + '\n'); return; }
    const h = /^#{1,6}\s+(.*)$/.exec(l);
    if (h) { write(c.bold(c.yellow(h[1])) + '\n'); return; }
    if (/^\s*\|?\s*:?-{2,}/.test(l) && l.includes('|')) { write(c.dim(l) + '\n'); return; }
    const o = l
      .replace(/\*\*(.+?)\*\*/g, (_, t) => c.bold(t))
      .replace(/`([^`]+)`/g, (_, t) => c.cyan(t))
      .replace(/^(\s*)[-*]\s+/, '$1• ');
    write(o + '\n');
  };
  return {
    push(t) {
      buf += t;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    end() { if (buf) { line(buf); buf = ''; } },
  };
}
