import test from 'node:test';

import { mountPlugin } from './harness.mjs';

async function probe(label, id, dx) {
  const { sandbox } = await mountPlugin();
  const doc = sandbox.document;
  const bar = doc.querySelector('.cy-dock');
  const free = bar.querySelector('[data-group="free"]');
  const ids = () => free.childNodes
    .filter((n) => n.dataset.id !== undefined)
    .map((n) => n.dataset.id)
    .join(',');
  const fire = (node, type, x, y) => {
    const ev = {
      type, target: node, button: 0, pointerId: 1, clientX: x, clientY: y,
      defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}
    };
    node.dispatchEvent(ev);
    return ev;
  };
  const btn = bar.querySelectorAll('.cy-btn').find((n) => n.dataset.id === id);
  const box = btn.getBoundingClientRect();
  const startX = box.left + box.width / 2;
  const startY = box.top + box.height / 2;
  fire(btn, 'pointerdown', startX, startY);
  const steps = Math.max(1, Math.ceil(Math.abs(dx) / 5));
  for (let at = 1; at <= steps; at += 1) fire(btn, 'pointermove', startX + (dx * at) / steps, startY);
  const mid = ids();
  fire(btn, 'pointerup', startX + dx, startY);
  console.log(`  ${label.padEnd(18)} press ${startX} -> ${startX + dx} | mid ${mid.padEnd(34)} | drop ${ids()}`);
}

test('table', async () => {
  console.log('');
  await probe('sound R+10', 'sound', 10);
  await probe('sound R+45', 'sound', 45);
  await probe('sound R+240', 'sound', 240);
  await probe('sound L-40', 'sound', -40);
  await probe('fonts L-40', 'fonts', -40);
  await probe('fonts L-200', 'fonts', -200);
  await probe('particles L-150', 'particles', -150);
  await probe('pointer L-200', 'pointer', -200);
});
