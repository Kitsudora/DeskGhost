const asset = name => new URL(`./assets/paper/${name}.svg`, import.meta.url).href;

export const paperAssets = Object.freeze({
  front: asset('card-front'), frontShadow: asset('card-front-shadow'),
  back: asset('card-back'), backShadow: asset('card-back-shadow'),
  backBand: asset('card-back-band'), note: asset('note-paper'),
  clipBack: asset('paperclip-back'), clipFront: asset('paperclip-front'),
  workspaceTag: asset('tag-workspace'), categoryTag: asset('tag-category')
});

const PAPER_COLORS = Object.freeze(['#f0bd78', '#f29b91', '#b9d879', '#80d5b2', '#7fcfe0', '#9cbaf0', '#c5a0e4', '#eaa1c6']);

let textMeasure;

/** Fit one complete line in the available physical label, without scrolling or
 * ellipses. Call after input, font loading, or a card size change. Sizes are px. */
export function fitCardText(node, { maxSize, minSize = .5, width, height, text } = {}) {
  if (!node?.isConnected) return 0;
  const style = getComputedStyle(node);
  const surface = node.closest('.dg-card-surface');
  let value = String(text ?? (node.value !== undefined ? node.value || node.placeholder : node.textContent) ?? '').replace(/[\r\n]+/g, ' ');
  const titleSize = /\p{Script=Han}/u.test(value) ? 88 : 95;
  const maximum = maxSize ?? (surface?.clientWidth ? surface.clientWidth * titleSize / 621.3463 : parseFloat(style.fontSize));
  const availableWidth = width ?? node.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
  const availableHeight = height ?? (node.parentElement?.clientHeight || node.clientHeight);
  if (!(maximum > 0) || !(availableWidth > 0) || !(availableHeight > 0)) return 0;
  textMeasure ||= document.createElement('canvas').getContext('2d');
  if (style.textTransform === 'uppercase') value = value.toLocaleUpperCase();
  else if (style.textTransform === 'lowercase') value = value.toLocaleLowerCase();
  const oldSize = parseFloat(style.fontSize) || maximum;
  const lineHeight = style.lineHeight === 'normal' ? 1.2 : (parseFloat(style.lineHeight) || oldSize) / oldSize;
  let size = Math.max(minSize, Math.min(maximum, availableHeight / lineHeight));
  // Inherited letter spacing can remain fixed in px while the font shrinks.
  // Measure the actual computed spacing at each bounded fitting step.
  for (let attempt = 0; attempt < 4; attempt++) {
    node.style.fontSize = `${size}px`;
    const current = getComputedStyle(node);
    textMeasure.font = `${current.fontStyle} ${current.fontWeight} ${size}px ${current.fontFamily}`;
    const spacing = (parseFloat(current.letterSpacing) || 0) * Math.max(0, [...value].length - 1);
    const glyphWidth = textMeasure.measureText(value).width;
    if (glyphWidth + spacing <= availableWidth - 2) break;
    size = Math.max(minSize, Math.min(size, size * Math.max(0, availableWidth - 2 - spacing) / Math.max(1, glyphWidth)));
  }
  node.style.fontSize = `${size}px`;
  node.scrollLeft = 0;
  node.scrollTop = 0;
  return size;
}

/** The same workspace ID/category name keeps its paper colour in every view. */
export function stablePaperColor(kind, key = '') {
  const text = `${kind}:${String(key)}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return PAPER_COLORS[(hash >>> 0) % PAPER_COLORS.length];
}

/** Mount decoration without replacing text fields, focus, or sticker controllers. */
export function mountCardLayers(surface, { side = 'front' } = {}) {
  surface.classList.add('dg-card-surface');
  surface.dataset.side = side === 'back' ? 'back' : 'front';
  const layer = className => {
    let node = surface.querySelector(`:scope > .${className}`);
    if (!node) { node = document.createElement('span'); node.className = className; node.setAttribute('aria-hidden', 'true'); }
    return node;
  };
  const shadow = layer('dg-card-shadow'), faceart = layer('dg-card-faceart');
  surface.prepend(shadow, faceart);
  return { shadow, faceart };
}

export function updatePaperTag(button, { label = '', key = label } = {}) {
  const kind = button.dataset.tag === 'workspace' ? 'workspace' : 'category';
  const text = String(label) || (kind === 'workspace' ? 'Workspace' : 'Uncategorized');
  button.querySelector('.dg-paper-tag-label').textContent = text;
  button.style.setProperty('--tag-color', stablePaperColor(kind, key));
  button.title = `${kind === 'workspace' ? 'Workspace' : 'Category'}: ${text}`;
  button.setAttribute('aria-label', `${button.title}. Open ${kind} selection.`);
}

export function createPaperTag({ kind = 'category', label = '', key = label, onClick } = {}) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'dg-paper-tag';
  button.dataset.tag = kind === 'workspace' ? 'workspace' : 'category';
  const text = document.createElement('span'); text.className = 'dg-paper-tag-label'; button.append(text);
  updatePaperTag(button, { label, key });
  if (onClick) button.addEventListener('click', event => { event.stopPropagation(); onClick(event); });
  return button;
}

export function createNoteClip({ onClick } = {}) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'dg-note-clip';
  button.setAttribute('aria-label', 'This task has notes. Open notes.'); button.title = 'Open notes';
  for (const side of ['back', 'front']) {
    const layer = document.createElement('span'); layer.className = `dg-note-clip-${side}`; layer.setAttribute('aria-hidden', 'true'); button.append(layer);
  }
  if (onClick) button.addEventListener('click', event => { event.stopPropagation(); onClick(event); });
  return button;
}
