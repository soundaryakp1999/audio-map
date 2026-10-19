// Going back from dialogs on a phone: a Back button at the top of each one, and the phone's own
// back button or gesture (Android, TalkBack) closes the open dialog instead of leaving the page.

/** Close a dialog the way Escape does: its cancel handler runs, or it simply closes. */
export function goBack(dlg: HTMLDialogElement) {
  const e = new Event('cancel', { cancelable: true });
  if (dlg.dispatchEvent(e) && dlg.open) dlg.close();
}

/** A Back button as the first thing in each dialog (before its heading), except those listed. */
export function addBackButtons(root: ParentNode, skip: string[] = []) {
  for (const dlg of root.querySelectorAll<HTMLDialogElement>('dialog')) {
    if (skip.includes(dlg.id)) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'back';
    b.textContent = 'Back';
    b.addEventListener('click', () => goBack(dlg));
    const box = dlg.querySelector(':scope > form') ?? dlg;
    box.prepend(b);
  }
}

/**
 * Each open dialog adds a history entry, so the phone's back press pops it and closes the dialog
 * on top. Closing a dialog any other way takes its entry off again.
 */
export function backClosesDialogs(root: ParentNode, win: Window = window) {
  const dialogs = [...root.querySelectorAll<HTMLDialogElement>('dialog')];
  const stack: HTMLDialogElement[] = []; // dialogs with an entry, oldest first
  let skipPops = 0; // pops we caused ourselves
  let waiting: HTMLDialogElement[] = []; // opened while one of our pops was on its way
  const push = (dlg: HTMLDialogElement) => {
    stack.push(dlg);
    win.history.pushState({ dialog: dlg.id }, '');
  };
  const watch = new MutationObserver((changes) => {
    for (const c of changes) {
      const dlg = c.target as HTMLDialogElement;
      if (!dlg.open || stack.includes(dlg) || waiting.includes(dlg)) continue;
      if (skipPops) waiting.push(dlg);
      else push(dlg);
    }
  });
  for (const dlg of dialogs) {
    watch.observe(dlg, { attributes: true, attributeFilter: ['open'] });
    dlg.addEventListener('close', () => {
      waiting = waiting.filter((d) => d !== dlg);
      const i = stack.indexOf(dlg);
      if (i < 0) return; // its entry was already popped by a back press
      const n = stack.length - i;
      stack.splice(i);
      skipPops++;
      win.history.go(-n);
    });
  }
  win.addEventListener('popstate', () => {
    if (skipPops) {
      skipPops--;
      if (!skipPops) {
        const w = waiting.filter((d) => d.open);
        waiting = [];
        w.forEach(push);
      }
      return;
    }
    // a dialog that refuses to close (the start menu before the first trip) stays open, and the
    // next back press leaves the page as usual
    const top = stack.pop();
    if (top) goBack(top);
  });
}
