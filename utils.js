export function uuid() {
  return (crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)) + Date.now().toString(36);
}

export function rectsOverlap(a, b, padding = 8) {
  return !(
    a.x + a.w + padding < b.x ||
    a.x > b.x + b.w + padding ||
    a.y + a.h + padding < b.y ||
    a.y > b.y + b.h + padding
  );
}

export function placeNonOverlapping(existing, startX, startY, w, h) {
  let x = startX, y = startY;
  const step = 24;
  for (let i = 0; i < 2000; i++) {
    const candidate = { x, y, w, h };
    const collides = existing.some(n => rectsOverlap(candidate, n));
    if (!collides) return candidate;
    const angle = i * 0.3;
    x = Math.round(startX + Math.cos(angle) * step * (1 + i * 0.02));
    y = Math.round(startY + Math.sin(angle) * step * (1 + i * 0.02));
  }
  return { x: startX + step * 2, y: startY + step * 2, w, h };
}

export function withinMarquee(node, m) {
  const nx1 = node.x, ny1 = node.y, nx2 = node.x + node.w, ny2 = node.y + node.h;
  const mx1 = Math.min(m.x1, m.x2), my1 = Math.min(m.y1, m.y2);
  const mx2 = Math.max(m.x1, m.x2), my2 = Math.max(m.y1, m.y2);
  return nx2 >= mx1 && nx1 <= mx2 && ny2 >= my1 && ny1 <= my2;
}

